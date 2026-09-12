/**
 * Checks that the project model form reads model.json the way the runtime does.
 *
 * Run with Node 22: npm run test:project-model
 *
 * A project's model used to be set by writing model.json by hand. The form that
 * replaced the textarea reads and writes the same file, and the runtime is
 * unforgiving about it: a project gets its own model only when `inheritsGlobal`
 * is not true and the provider/model pair can be served right now, and anything
 * else quietly answers with the workspace model. If the form's reading of the
 * file drifts from that, it shows one model while another answers.
 */
import assert from "node:assert/strict";
import {
  parseProjectModelFile,
  projectModelChoiceComplete,
  projectModelChoiceServable,
  projectModelOptions,
  projectProviderOptions,
  sameProjectModelChoice,
  serializeProjectModelFile,
  workspaceModelSummary,
  type ProjectModelsState,
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

console.log("model.json is read the way the runtime reads it:");
check("inheritsGlobal true follows the workspace", () =>
  assert.equal(parseProjectModelFile('{ "inheritsGlobal": true }').choice.mode, "workspace")
);
check("false with a provider and a model is the project's own", () =>
  assert.deepEqual(parseProjectModelFile('{ "inheritsGlobal": false, "provider": "alpha", "model": "a/b" }').choice, {
    mode: "project",
    provider: "alpha",
    model: "a/b",
  })
);
check("no inheritsGlobal at all still counts, as it does for the runtime", () =>
  assert.equal(parseProjectModelFile('{ "provider": "alpha", "model": "a/b" }').choice.mode, "project")
);
check("false without a model follows the workspace, as it does for the runtime", () =>
  assert.equal(parseProjectModelFile('{ "inheritsGlobal": false, "provider": "alpha" }').choice.mode, "workspace")
);
check("a remembered pick survives while following the workspace", () =>
  assert.deepEqual(parseProjectModelFile('{ "inheritsGlobal": true, "provider": "p", "model": "m" }').choice, {
    mode: "workspace",
    provider: "p",
    model: "m",
  })
);
check("an empty file follows the workspace", () => {
  const parsed = parseProjectModelFile("");
  assert.equal(parsed.readable, true);
  assert.equal(parsed.choice.mode, "workspace");
});
for (const [content, why] of [
  ["{ inheritsGlobal: false", "broken JSON"],
  ["[1, 2]", "an array"],
  ['"text"', "a bare string"],
] as Array<[string, string]>) {
  check(`${why} is reported unreadable and starts from the workspace`, () => {
    const parsed = parseProjectModelFile(content);
    assert.equal(parsed.readable, false);
    assert.equal(parsed.choice.mode, "workspace");
  });
}

console.log("\na save writes exactly what the runtime needs, and keeps the rest:");
check("following the workspace", () =>
  assert.deepEqual(JSON.parse(serializeProjectModelFile({ mode: "workspace", provider: "p", model: "m" })), {
    inheritsGlobal: true,
  })
);
check("the project's own", () =>
  assert.deepEqual(JSON.parse(serializeProjectModelFile({ mode: "project", provider: "p", model: "m" })), {
    inheritsGlobal: false,
    provider: "p",
    model: "m",
  })
);
check("keys the form does not own are carried through", () => {
  const parsed = parseProjectModelFile('{ "inheritsGlobal": true, "note": "keep me", "limits": { "x": 1 } }');
  const written = JSON.parse(serializeProjectModelFile({ mode: "project", provider: "p", model: "m" }, parsed.extra));
  assert.deepEqual(written, { inheritsGlobal: false, provider: "p", model: "m", note: "keep me", limits: { x: 1 } });
});
check("what is written reads back as the same choice", () => {
  const choice = { mode: "project" as const, provider: "alpha", model: "a/b" };
  assert.deepEqual(parseProjectModelFile(serializeProjectModelFile(choice)).choice, choice);
});
check("two workspace choices are the same whatever they remember", () =>
  assert.ok(sameProjectModelChoice({ mode: "workspace", provider: "a", model: "b" }, { mode: "workspace", provider: "", model: "" }))
);
check("a project choice without a model cannot be saved", () =>
  assert.equal(projectModelChoiceComplete({ mode: "project", provider: "p", model: "" }), false)
);

console.log("\nonly what can answer is offered, the included model under its label:");
// Listed out of order on purpose, so the sort is what puts them in order.
const ownProvider: ProjectModelsState = {
  providers: [
    { id: "bravo", name: "Bravo" },
    { id: "alpha", name: "Alpha" },
    { id: "charlie", name: "Charlie" },
    { id: "eggent-ai", name: "Eggent AI" },
  ],
  availableModels: [
    { provider: "alpha", id: "z/model" },
    { provider: "alpha", id: "a/model" },
    { provider: "bravo", id: "b-1" },
    { provider: "eggent-ai", id: "eggent-ai", name: "Eggent AI" },
  ],
  managed: { providerId: "eggent-ai", label: "Eggent AI" },
  modelLock: { locked: false, label: "Eggent AI" },
  current: { provider: "alpha", providerName: "Alpha", model: { id: "z/model", available: true } },
};
check("connected providers, by name, then the included model", () =>
  assert.deepEqual(projectProviderOptions(ownProvider).map((option) => option.id), ["alpha", "bravo", "eggent-ai"])
);
check("a provider with no servable model is not offered", () =>
  assert.ok(!projectProviderOptions(ownProvider).some((option) => option.id === "charlie"))
);
check("the included model is marked, so the form never names the model behind it", () =>
  assert.deepEqual(projectProviderOptions(ownProvider).at(-1), { id: "eggent-ai", name: "Eggent AI", managed: true })
);
check("the included model is not offered when it cannot answer", () =>
  assert.ok(
    !projectProviderOptions({
      ...ownProvider,
      availableModels: ownProvider.availableModels!.filter((model) => model.provider !== "eggent-ai"),
    }).some((option) => option.managed)
  )
);
check("the included model is found under whichever id it was provisioned", () => {
  const state: ProjectModelsState = {
    ...ownProvider,
    managed: { providerId: "eggent-managed", label: "Eggent AI" },
    availableModels: [...ownProvider.availableModels!, { provider: "eggent-managed", id: "eggent-managed" }],
  };
  assert.deepEqual(projectProviderOptions(state).filter((option) => option.managed).map((option) => option.id), ["eggent-managed"]);
});
check("models of one provider, sorted", () =>
  assert.deepEqual(projectModelOptions(ownProvider, "alpha").map((model) => model.id), ["a/model", "z/model"])
);

console.log("\nthe form can tell when the runtime will not honour the file:");
check("a servable choice", () =>
  assert.ok(projectModelChoiceServable(ownProvider, { mode: "project", provider: "bravo", model: "b-1" }))
);
check("a disconnected provider", () =>
  assert.equal(projectModelChoiceServable(ownProvider, { mode: "project", provider: "charlie", model: "c-1" }), false)
);
check("a model the provider no longer offers", () =>
  assert.equal(projectModelChoiceServable(ownProvider, { mode: "project", provider: "alpha", model: "gone" }), false)
);
check("following the workspace is always honoured", () =>
  assert.ok(projectModelChoiceServable(ownProvider, { mode: "workspace", provider: "", model: "" }))
);

console.log("\nthe workspace model is named the way Settings names it:");
check("its provider and model", () =>
  assert.deepEqual(workspaceModelSummary(ownProvider), { provider: "Alpha", model: "z/model" })
);
check("the included model by its label alone", () =>
  assert.deepEqual(workspaceModelSummary({ ...ownProvider, modelLock: { locked: true, label: "Eggent AI" } }), { provider: "Eggent AI" })
);
check("nothing, when the workspace has no model it can serve", () =>
  assert.equal(
    workspaceModelSummary({ ...ownProvider, current: { provider: "alpha", model: { id: "z/model", available: false } } }),
    null
  )
);
check("what answers, when the saved model is not one the provider lists", () =>
  // The saved model is gone from the provider's list, so the runtime fell back
  // to another one. Reporting nothing here is what made the project form say
  // "no model selected" over a workspace that had one.
  assert.deepEqual(
    workspaceModelSummary({
      ...ownProvider,
      current: null,
      runtimeModel: { provider: "alpha", providerName: "Alpha", model: { id: "a/model" } },
    }),
    { provider: "Alpha", model: "a/model" }
  )
);
check("what answers outranks what is written down", () =>
  assert.deepEqual(
    workspaceModelSummary({
      ...ownProvider,
      runtimeModel: { provider: "bravo", providerName: "Bravo", model: { id: "b-1" } },
    }),
    { provider: "Bravo", model: "b-1" }
  )
);

console.log(failed === 0 ? `\nall ${ran} checks passed` : `\n${failed} of ${ran} checks failed`);
process.exit(failed === 0 ? 0 : 1);
