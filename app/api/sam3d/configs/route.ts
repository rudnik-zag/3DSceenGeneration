import { NextResponse } from "next/server";

import { getDefaultSam3dConfig, listSam3dConfigOptions } from "@/lib/sam3d/configs";

export async function GET() {
  const configs = await listSam3dConfigOptions();
  return NextResponse.json({
    defaultConfig: getDefaultSam3dConfig(),
    configs
  });
}

