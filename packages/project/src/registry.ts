import { coreDomain, createRegistry, type NodeRegistry } from "@gamestudio/rules-core";
import { owareDomain } from "@gamestudio/oware";
import { ludoDomain } from "@gamestudio/ludo";
import { exploreDomain } from "@gamestudio/explore";
import { platformerDomain } from "@gamestudio/platformer";
import { footballDomain } from "@gamestudio/football";
import { farmDomain } from "@gamestudio/farm";

/** Every rule domain built into this studio version. */
export function createStudioRegistry(): NodeRegistry {
  return createRegistry([coreDomain, owareDomain, ludoDomain, exploreDomain, platformerDomain, footballDomain, farmDomain]);
}
