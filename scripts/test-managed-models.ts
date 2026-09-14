/**
 * The included plan now holds several models, and three separate things decide
 * which one answers: the list fetched from the gateway, what the workspace
 * saved, and what a project saved. This checks the rules that join them.
 *
 * Run with Node 22: npm run test:managed-models
 *
 * Two failures are worth naming because they are the ones this covers. A
 * workspace provisioned before the catalog has a saved model whose id is the
 * provider id; if the list replaces it and nothing moves that setting, the
 * workspace is left pointing at a model no registry holds - which is exactly
 * how a workspace ended up answering with a model nobody chose. And a project
 * choice under the lock is written as a provider plus a model id, where the
 * provider is written one way by the screens and another way by provisioning;
 * reading only one of them silently drops the choice.
 */
import assert from "node:assert/strict";
import {
  managedDefaultTextModel,
  parseManagedCatalogPayload,
  type ManagedCatalogModel,
} from "../src/lib/pi/managed-models.ts";
import {
  isManagedChoiceProvider,
  pickManagedRuntimeModel,
  managedProjectSaveRefusal,
  maskProjectModelUnderLock,
  parseProjectModelFile,
  serializeProjectModelFile,
  workspaceModelSummary,
} from "../src/lib/pi/project-model-choice.ts";

let failed = 0;
let ran = 0;
function check(name: string, fn: () => void): void {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

const payload = {
  object: "list",
  data: [
    {
      id: "included-base",
      object: "model",
      owned_by: "eggent",
      eggent: {
        name: "Included Base",
        kind: "text",
        description: "Balanced.",
        context_window: 272000,
        max_tokens: 128000,
        input: ["text", "image"],
        reasoning: true,
        default: true,
        price: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.5, currency: "XTS" },
      },
    },
    {
      id: "included-cheap",
      object: "model",
      eggent: { name: "Included Cheap", kind: "text", price: { input: 0.4, currency: "XTS", output: 2 } },
    },
    { id: "included-image", object: "model", eggent: { name: "Included Image", kind: "image" } },
    { id: "included-vectors", object: "model", eggent: { kind: "embedding" } },
  ],
};

console.log("reading the deployment's answer:");
check("every model comes back, in the order it was sent", () => {
  assert.deepEqual(
    parseManagedCatalogPayload(payload).map((model) => model.id),
    ["included-base", "included-cheap", "included-image", "included-vectors"]
  );
});
check("name, window and price are carried across", () => {
  const model = parseManagedCatalogPayload(payload)[0];
  assert.equal(model.name, "Included Base");
  assert.equal(model.contextWindow, 272000);
  assert.equal(model.maxTokens, 128000);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.price?.output, 9);
  assert.equal(model.price?.currency, "XTS");
});
check("a model that says nothing about itself still works", () => {
  const model = parseManagedCatalogPayload(payload).find((entry) => entry.id === "included-vectors")!;
  assert.equal(model.name, "included-vectors", "the id is the fallback name");
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.reasoning, false);
  assert.equal(model.default, false);
});
check("cache prices fall back to the input price rather than to zero", () => {
  // Zero here would bill a cached million tokens as free.
  const model = parseManagedCatalogPayload(payload).find((entry) => entry.id === "included-cheap")!;
  assert.equal(model.price?.cacheRead, 0.4);
  assert.equal(model.price?.cacheWrite, 0.4);
});
check("a row with no id is dropped, not given one", () => {
  const models = parseManagedCatalogPayload({ data: [{ object: "model" }, { id: "  " }, { id: "real" }] });
  assert.deepEqual(models.map((model) => model.id), ["real"]);
});
check("a document of the wrong shape is an empty list, not a crash", () => {
  for (const bad of [null, undefined, 42, "list", { data: "no" }, {}]) {
    assert.deepEqual(parseManagedCatalogPayload(bad), []);
  }
});

console.log("\nwhich one answers when nothing was chosen:");
const catalog = parseManagedCatalogPayload(payload);
check("the one the deployment marked default", () => {
  assert.equal(managedDefaultTextModel(catalog)?.id, "included-base");
});
check("with none marked, the first text model", () => {
  const unmarked: ManagedCatalogModel[] = catalog.map((model) => ({ ...model, default: false }));
  assert.equal(managedDefaultTextModel(unmarked)?.id, "included-base");
});
check("never an image or embedding model", () => {
  // Picking one of these as the chat model breaks every conversation in the
  // workspace, and they are in the same list.
  const noText = catalog.filter((model) => model.kind !== "text");
  assert.equal(managedDefaultTextModel(noText), undefined);
});

console.log("\nthe included provider is named two ways and both must be read:");
check("the id the workspace was provisioned under", () => {
  assert.equal(isManagedChoiceProvider("eggent-managed-7", "eggent-managed-7"), true);
});
check("the literal every screen sends", () => {
  assert.equal(isManagedChoiceProvider("eggent-ai", "eggent-managed-7"), true);
});
check("somebody else's provider is not it", () => {
  assert.equal(isManagedChoiceProvider("some-other-provider", "eggent-managed-7"), false);
  assert.equal(isManagedChoiceProvider("", "eggent-managed-7"), false);
});

console.log("\nwhat a project may keep under the plan:");
const included = serializeProjectModelFile({ mode: "project", provider: "eggent-ai", model: "included-cheap" });
const foreign = serializeProjectModelFile({ mode: "project", provider: "some-other-provider", model: "their-model" });
const ids = catalog.filter((model) => model.kind === "text").map((model) => model.id);

check("an included model survives being read back", () => {
  const shown = maskProjectModelUnderLock(included, "eggent-managed-7");
  assert.equal(parseProjectModelFile(shown).choice.model, "included-cheap");
});
check("somebody else's provider is masked to following the workspace", () => {
  // Showing it would let the form offer a choice the runtime is going to ignore.
  const shown = maskProjectModelUnderLock(foreign, "eggent-managed-7");
  assert.equal(parseProjectModelFile(shown).choice.mode, "workspace");
});
check("an unreadable file reads as following the workspace", () => {
  assert.equal(parseProjectModelFile(maskProjectModelUnderLock("{ broken", "eggent-ai")).choice.mode, "workspace");
});

check("saving an included model is allowed", () => {
  assert.equal(managedProjectSaveRefusal(included, "eggent-managed-7", ids), null);
});
check("saving under the provisioned id is allowed too", () => {
  const own = serializeProjectModelFile({ mode: "project", provider: "eggent-managed-7", model: "included-base" });
  assert.equal(managedProjectSaveRefusal(own, "eggent-managed-7", ids), null);
});
check("following the workspace is always allowed", () => {
  assert.equal(managedProjectSaveRefusal(serializeProjectModelFile({ mode: "workspace", provider: "", model: "" }), "eggent-ai", ids), null);
});
check("somebody else's provider is refused, not saved and dropped", () => {
  assert.equal(managedProjectSaveRefusal(foreign, "eggent-managed-7", ids), "foreign_provider");
});
check("a model the plan does not offer is refused by name", () => {
  const missing = serializeProjectModelFile({ mode: "project", provider: "eggent-ai", model: "included-gone" });
  assert.equal(managedProjectSaveRefusal(missing, "eggent-managed-7", ids), "unknown_model");
});
check("with no catalog yet there is one model and no choice to get wrong", () => {
  // A workspace that has never reached the gateway. Refusing here would stop it
  // saving the only model it has.
  const missing = serializeProjectModelFile({ mode: "project", provider: "eggent-ai", model: "Eggent AI" });
  assert.equal(managedProjectSaveRefusal(missing, "eggent-ai", []), null);
});
check("a file that is not JSON is refused as that, not as a bad provider", () => {
  assert.equal(managedProjectSaveRefusal("{ broken", "eggent-ai", ids), "not_json");
});

console.log("\nwhich included model a run answers with:");
const offered = [
  { provider: "eggent-managed-7", id: "included-base" },
  { provider: "eggent-managed-7", id: "included-mid" },
  { provider: "eggent-managed-7", id: "included-cheap" },
];
const base = { managedAvailable: offered, managedProvider: "eggent-managed-7", catalogDefaultId: "included-base" };

check("the project's choice beats the workspace's", () => {
  // The point of letting a project choose at all: bulk work on a cheap model
  // while the workspace stays on the good one.
  assert.equal(
    pickManagedRuntimeModel({
      ...base,
      projectChoice: { provider: "eggent-ai", model: "included-cheap" },
      workspaceChoice: { provider: "eggent-managed-7", model: "included-base" },
    })?.id,
    "included-cheap"
  );
});
check("with no project choice, the workspace's", () => {
  assert.equal(
    pickManagedRuntimeModel({ ...base, workspaceChoice: { provider: "eggent-managed-7", model: "included-mid" } })?.id,
    "included-mid"
  );
});
check("with neither, the deployment's default", () => {
  assert.equal(pickManagedRuntimeModel({ ...base })?.id, "included-base");
});
check("a withdrawn model falls through rather than stopping the run", () => {
  assert.equal(
    pickManagedRuntimeModel({ ...base, workspaceChoice: { provider: "eggent-ai", model: "included-withdrawn" } })?.id,
    "included-base"
  );
});
check("a project naming somebody else's provider is ignored, not obeyed", () => {
  assert.equal(
    pickManagedRuntimeModel({
      ...base,
      projectChoice: { provider: "some-other-provider", model: "their-model" },
      workspaceChoice: { provider: "eggent-ai", model: "included-mid" },
    })?.id,
    "included-mid"
  );
});
check("with no default named, the first on offer - never nothing", () => {
  assert.equal(pickManagedRuntimeModel({ ...base, catalogDefaultId: undefined })?.id, "included-base");
});
check("nothing on offer is undefined, so the run says so instead of guessing", () => {
  assert.equal(pickManagedRuntimeModel({ ...base, managedAvailable: [] }), undefined);
});

console.log("\nthe workspace model is named, not just the plan:");
check("the model answering now is shown beside the label", () => {
  assert.deepEqual(
    workspaceModelSummary({
      modelLock: { locked: true, label: "Eggent AI" },
      runtimeModel: { provider: "eggent-ai", providerName: "Eggent AI", model: { id: "included-cheap", name: "Included Cheap" } },
    }),
    { provider: "Eggent AI", model: "Included Cheap" }
  );
});
check("a model with no name of its own falls back to its id", () => {
  assert.deepEqual(
    workspaceModelSummary({
      modelLock: { locked: true, label: "Eggent AI" },
      runtimeModel: { provider: "eggent-ai", model: { id: "included-base" } },
    }),
    { provider: "Eggent AI", model: "included-base" }
  );
});
check("with nothing resolved yet, the label alone", () => {
  assert.deepEqual(workspaceModelSummary({ modelLock: { locked: true, label: "Eggent AI" } }), { provider: "Eggent AI" });
});

console.log(failed === 0 ? `\nall ${ran} checks passed` : `\n${failed} of ${ran} failed`);
process.exit(failed === 0 ? 0 : 1);
