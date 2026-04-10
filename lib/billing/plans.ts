export type SubscriptionPlanKey = "Free" | "Creator" | "Pro" | "Studio";

export interface PlanEntitlements {
  canCreateProject: boolean;
  maxProjects: number;
  maxStorageGb: number;
  maxUploadMb: number;
  canRunSceneGeneration: boolean;
  canUseAdvancedNodes: boolean;
  canExportHighQuality: boolean;
  maxConcurrentRuns: number;
  queuePriority: number;
  monthlyTokenAllowance: number;
}

export interface PlanDefinition {
  key: SubscriptionPlanKey;
  title: string;
  description: string;
  monthlyPriceUsd: number;
  stripePriceId: string | null;
  entitlements: PlanEntitlements;
}

export interface TokenPackDefinition {
  key: string;
  title: string;
  description: string;
  tokens: number;
  priceUsd: number;
  stripePriceId: string | null;
}

function envValue(name: string) {
  const raw = process.env[name];
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const planDefinitions: Record<SubscriptionPlanKey, PlanDefinition> = {
  Free: {
    key: "Free",
    title: "Free",
    description: "Explore the app with strict limits.",
    monthlyPriceUsd: 0,
    stripePriceId: envValue("STRIPE_PRICE_FREE_MONTHLY"),
    entitlements: {
      canCreateProject: true,
      maxProjects: 1,
      maxStorageGb: 1,
      maxUploadMb: 20,
      canRunSceneGeneration: true,
      canUseAdvancedNodes: false,
      canExportHighQuality: false,
      maxConcurrentRuns: 1,
      queuePriority: 5,
      monthlyTokenAllowance: 200
    }
  },
  Creator: {
    key: "Creator",
    title: "Creator",
    description: "For solo builders with regular generation needs.",
    monthlyPriceUsd: 19,
    stripePriceId: envValue("STRIPE_PRICE_CREATOR_MONTHLY"),
    entitlements: {
      canCreateProject: true,
      maxProjects: 10,
      maxStorageGb: 25,
      maxUploadMb: 100,
      canRunSceneGeneration: true,
      canUseAdvancedNodes: true,
      canExportHighQuality: false,
      maxConcurrentRuns: 2,
      queuePriority: 4,
      monthlyTokenAllowance: 5000
    }
  },
  Pro: {
    key: "Pro",
    title: "Pro",
    description: "Higher limits, advanced features, faster queue priority.",
    monthlyPriceUsd: 59,
    stripePriceId: envValue("STRIPE_PRICE_PRO_MONTHLY"),
    entitlements: {
      canCreateProject: true,
      maxProjects: 50,
      maxStorageGb: 200,
      maxUploadMb: 250,
      canRunSceneGeneration: true,
      canUseAdvancedNodes: true,
      canExportHighQuality: true,
      maxConcurrentRuns: 4,
      queuePriority: 2,
      monthlyTokenAllowance: 20000
    }
  },
  Studio: {
    key: "Studio",
    title: "Studio",
    description: "Team-ready tier with the highest limits.",
    monthlyPriceUsd: 149,
    stripePriceId: envValue("STRIPE_PRICE_STUDIO_MONTHLY"),
    entitlements: {
      canCreateProject: true,
      maxProjects: 200,
      maxStorageGb: 1000,
      maxUploadMb: 500,
      canRunSceneGeneration: true,
      canUseAdvancedNodes: true,
      canExportHighQuality: true,
      maxConcurrentRuns: 8,
      queuePriority: 1,
      monthlyTokenAllowance: 80000
    }
  }
};

export const planOrder: SubscriptionPlanKey[] = ["Free", "Creator", "Pro", "Studio"];

export function isSubscriptionPlanKey(value: string): value is SubscriptionPlanKey {
  return value in planDefinitions;
}

export function getPlanDefinition(plan: SubscriptionPlanKey) {
  return planDefinitions[plan];
}

export const tokenPackDefinitions: TokenPackDefinition[] = [
  {
    key: "pack_starter",
    title: "Starter Pack",
    description: "Top up with extra compute credits.",
    tokens: 2000,
    priceUsd: 10,
    stripePriceId: envValue("STRIPE_PRICE_TOKEN_PACK_STARTER")
  },
  {
    key: "pack_growth",
    title: "Growth Pack",
    description: "For sustained usage spikes.",
    tokens: 10000,
    priceUsd: 45,
    stripePriceId: envValue("STRIPE_PRICE_TOKEN_PACK_GROWTH")
  },
  {
    key: "pack_scale",
    title: "Scale Pack",
    description: "Best value for heavy workloads.",
    tokens: 30000,
    priceUsd: 120,
    stripePriceId: envValue("STRIPE_PRICE_TOKEN_PACK_SCALE")
  }
];

export function getTokenPackByKey(packKey: string) {
  return tokenPackDefinitions.find((pack) => pack.key === packKey) ?? null;
}

export function getTokenPackByStripePriceId(priceId: string) {
  return tokenPackDefinitions.find((pack) => pack.stripePriceId === priceId) ?? null;
}

export function getPlanByStripePriceId(priceId: string) {
  return planOrder.find((plan) => planDefinitions[plan].stripePriceId === priceId) ?? null;
}
