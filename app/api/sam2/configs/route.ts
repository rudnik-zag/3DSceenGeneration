import { NextResponse } from "next/server";

import { getDefaultSam2Config, listSam2ConfigOptions } from "@/lib/sam2/configs";

export async function GET() {
  const configs = await listSam2ConfigOptions();
  return NextResponse.json({
    defaultConfig: getDefaultSam2Config(),
    configs
  });
}

