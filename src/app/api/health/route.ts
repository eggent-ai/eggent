import { version } from "../../../../package.json";

/**
 * Liveness, and the one place that answers which build is running.
 *
 * The version is read from package.json at build time rather than written here
 * by hand: the two drifted at 0.2.1, and a health endpoint that reports the
 * previous release is worse than one that reports nothing - it is the thing you
 * check to find out what is deployed.
 */
export async function GET() {
  return Response.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version,
  });
}
