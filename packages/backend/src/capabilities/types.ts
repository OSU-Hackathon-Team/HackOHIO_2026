import type {
  CapabilityIntakeRecord,
  CapabilityPackage,
  CapabilityDefinition,
  PublicTestCase,
  ImplementationSource,
} from "@splice/contracts";

export interface ArtifactFile {
  path: string;
  data: Buffer;
}

/** Read-only surface used by composition, export and verification code. */
export interface CapabilityResolver {
  listPackages(): Promise<CapabilityPackage[]>;
  getPackage(packageId: string): Promise<CapabilityPackage | null>;
  /** Directory containing the package's verified artifacts. */
  artifactRoot(pkg: CapabilityPackage): string;
  readArtifact(pkg: CapabilityPackage, path: string): Promise<Buffer>;
}

/** Server-owned content-addressed registry. Uploaded verification fields are never trusted. */
export interface CapabilityRegistry extends CapabilityResolver {
  getIntake(intakeId: string): Promise<CapabilityIntakeRecord | null>;
  listIntakes(): Promise<CapabilityIntakeRecord[]>;
  putIntake(record: CapabilityIntakeRecord): Promise<void>;
  putPackage(pkg: CapabilityPackage, files: ArtifactFile[]): Promise<void>;
}

export interface BuildHooks {
  signal?: AbortSignal;
  onStage(stage: string, message: string, pct: number): void;
  onLog?(message: string): void;
}

export interface BuiltPackage {
  package: CapabilityPackage;
  files: ArtifactFile[];
}

export interface BuildInput {
  definition: CapabilityDefinition;
  implementation: ImplementationSource;
  public_tests: PublicTestCase[];
  intake_id: string;
}

export interface PackageBuilder {
  build(input: BuildInput, hooks: BuildHooks): Promise<BuiltPackage>;
}
