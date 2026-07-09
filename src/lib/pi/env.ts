import path from "path";

/**
 * Eggent embeds the pi SDK. A fresh Eggent install should not require users to
 * install/configure a global pi CLI first, and Docker config must persist in
 * ./data. If the deployer did not choose a pi agent dir explicitly, keep pi's
 * auth.json/models.json/settings.json under data/pi-agent.
 */
if (!process.env.PI_CODING_AGENT_DIR?.trim()) {
  process.env.PI_CODING_AGENT_DIR = path.join(process.cwd(), "data", "pi-agent");
}
