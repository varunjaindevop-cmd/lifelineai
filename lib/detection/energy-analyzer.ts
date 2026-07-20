// Energy-Based Collision Detection
// Uses physics: KE = 0.5 * m * v^2
// A collision transfers energy between objects
// If object A was fast and now slow, and object B was slow and is now stopped = energy transfer

import { TrackedEntity } from "../detection/kalman-tracker";

export interface EnergyAnalysis {
  entityId: number;
  kineticEnergy: number;     // current KE
  prevKineticEnergy: number; // KE from a few frames ago
  energyChange: number;      // how much energy was lost/gained
  energyTransfer: boolean;   // did this entity lose energy to another?
}

// Approximate mass by vehicle type (for energy calculation)
const MASS_MAP: Record<string, number> = {
  car: 1.5,
  truck: 3.0,
  bus: 4.0,
  motorcycle: 0.3,
  person: 0.08,
};

/**
 * Calculate kinetic energy for an entity
 * KE = 0.5 * m * v^2 (simplified, using pixel speed as proxy)
 */
function kineticEnergy(entity: TrackedEntity): number {
  const mass = MASS_MAP[entity.class] || 1.0;
  const speed = entity.kalman.getSpeed();
  return 0.5 * mass * speed * speed;
}

/**
 * Analyze energy changes across all entities
 * Detects energy transfer events (collisions)
 */
export function analyzeEnergy(entities: TrackedEntity[]): EnergyAnalysis[] {
  return entities
    .filter(e => e.age >= 3 && e.speedHistory.length >= 3)
    .map(entity => {
      const currentKE = kineticEnergy(entity);

      // Calculate KE from 3 frames ago
      const oldSpeed = entity.speedHistory[Math.min(2, entity.speedHistory.length - 1)];
      const mass = MASS_MAP[entity.class] || 1.0;
      const prevKE = 0.5 * mass * oldSpeed * oldSpeed;

      const energyChange = prevKE - currentKE; // positive = lost energy

      // Energy transfer: entity lost significant energy while nearby another entity
      const energyTransfer = energyChange > 0.5 && entity.speed < oldSpeed * 0.3;

      return {
        entityId: entity.id,
        kineticEnergy: currentKE,
        prevKineticEnergy: prevKE,
        energyChange,
        energyTransfer,
      };
    });
}

/**
 * Detect energy transfer events (collisions)
 * Two objects: one loses energy, the other is nearby and also affected
 */
export function detectEnergyTransfer(
  entities: TrackedEntity[],
  energyData: EnergyAnalysis[]
): { a: number; b: number; severity: number }[] {
  const transfers: { a: number; b: number; severity: number }[] = [];

  // Find entities that lost significant energy
  const energyLosers = energyData.filter(e => e.energyTransfer);

  for (const loser of energyLosers) {
    const loserEntity = entities.find(e => e.id === loser.entityId);
    if (!loserEntity) continue;

    // Find nearby entities that also show energy change
    for (const other of energyData) {
      if (other.entityId === loser.entityId) continue;

      const otherEntity = entities.find(e => e.id === other.entityId);
      if (!otherEntity) continue;

      const dx = loserEntity.kalman.getState().x - otherEntity.kalman.getState().x;
      const dy = loserEntity.kalman.getState().y - otherEntity.kalman.getState().y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const combinedSize = (Math.sqrt(loserEntity.w * loserEntity.h) + Math.sqrt(otherEntity.w * otherEntity.h)) / 2;

      // Must be close
      if (distance > combinedSize * 2) continue;

      // Severity based on energy change magnitude
      const severity = Math.min(1.0, loser.energyChange / 5);

      transfers.push({
        a: loser.entityId,
        b: other.entityId,
        severity,
      });
    }
  }

  return transfers;
}
