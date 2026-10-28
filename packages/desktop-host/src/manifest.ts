import type { CapabilityDefinition, CapabilityPackage, CompositionPlan, HostEffect } from "@splice/contracts";

export interface ApplicationPlanManifest {
  schema_version: 1;
  app_id: string;
  plan: CompositionPlan;
  packages: Array<{
    instance: string;
    package: CapabilityPackage;
    definition: CapabilityDefinition;
    permissions: HostEffect[];
  }>;
}
