import { NextResponse } from "next/server";
import { cloudPromoShown } from "@/lib/cloud-promo";
import { deploymentNotice } from "@/lib/pi/config-store";

/**
 * What the operator of this deployment wants shown to users.
 *
 * Self-hosted Eggent normally configures nothing here and gets an empty notice,
 * and the one card about Eggent Cloud (`cloudPromo`), which a deployment of its
 * own turns off.
 */
export async function GET() {
  return NextResponse.json({ notice: deploymentNotice() ?? null, cloudPromo: cloudPromoShown() });
}
