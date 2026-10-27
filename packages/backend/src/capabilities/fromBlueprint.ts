import { FeatureBlueprint, CapabilityDefinition, type CapabilityIntakeRequest, type PublicTestCase } from "@splice/contracts";
import { hashJson } from "./identity.js";

/** Wrap an existing verified pure-TS blueprint without guessing its cross-language contract. */
export function fromBlueprint(
  rawBlueprint: unknown,
  definitionValue: CapabilityDefinition,
  publicTests: PublicTestCase[],
): CapabilityIntakeRequest {
  const blueprint = FeatureBlueprint.parse(rawBlueprint);
  const definition = CapabilityDefinition.parse(definitionValue);
  if (blueprint.verification.status !== "passed" || blueprint.spec.status !== "verified" || blueprint.spec.oracle.status !== "passed") {
    throw new Error("Only a blueprint with a passed engine check and original-code oracle can be wrapped");
  }
  if (
    definition.origin.kind !== "feature_spec" ||
    definition.origin.stage !== "requirements" ||
    definition.origin.artifact_hash !== hashJson(blueprint.spec) ||
    definition.origin.source_app !== blueprint.spec.source_app
  ) {
    throw new Error("CapabilityDefinition origin does not pin this blueprint's FeatureSpec");
  }
  const exportedFunctions = new Set(blueprint.spec.interface.exports.filter((item) => item.kind === "function").map((item) => item.name));
  for (const operation of definition.operations) {
    if (!exportedFunctions.has(operation.name)) {
      throw new Error(`Operation ${operation.name} has no matching function export in the blueprint; supply an explicit adapter instead of renaming behavior`);
    }
  }
  if (blueprint.implementation.module_name !== blueprint.spec.interface.module_name) {
    throw new Error("Blueprint implementation module identity does not match its FeatureSpec");
  }
  const entry = `${blueprint.spec.interface.module_name}.ts`;
  return {
    definition,
    origin_artifact: blueprint.spec,
    review_attestation: null,
    implementation: { kind: "typescript", entry, files: [{ path: entry, content: blueprint.implementation.portable_code, encoding: "utf8" }] },
    public_tests: publicTests,
    independent_verdict: null,
  };
}
