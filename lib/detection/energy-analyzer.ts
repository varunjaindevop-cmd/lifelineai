// Energy-Based Collision Detection
// Uses physics: KE = 0.5 * m * v^2
// Detects energy transfer events that indicate collisions

import { TrackedEntity } from "./kalman-tracker";

export interface EnergyAnalysis {
  entityId: number;
  kineticEnergy: number;
  prevKineticEnergy: number;
  energyChange: number;
  energyTransfer: boolean;
}

const MASS_MAP: Record<string, number> = {
  car: 1.5,
  truck: 3.0,
  bus: 4.0,
  motorcycle: 0.3,
  person: 0.08,
};

function kineticEnergy(entity: TrackedEntity): number {
  const mass = MASS_MAP[entity.class] || 1.0;
  const speed = entity.kalman.getSpeed();
  return 0.5 * mass * speed * speed;
}

export function analyzeEnergy(entities: TrackedEntity[]): EnergyAnalysis[] {
  return entities
    .filter(e => e.age >= 3 && e.speedHistory.length >= 3)
    .map(entity => {
      const currentKE = kineticEnergy(entity);

      const oldSpeed = entity.speedHistory[Math.min(2, entity.speedHistory.length - 1)];
      const mass = MASS_MAP[entity.class] || 1.0;
      const prevKE = 0.5 * mass * oldSpeed * oldSpeed;

      const energyChange = prevKE - currentKE;
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

export function detectEnergyTransfer(
  entities: TrackedEntity[],
  energyData: EnergyAnalysis[]
): { a: number; b: number; severity: number }[] {
  const transfers: { a: number; b: number; severity: number }[] = [];
  const energyLosers = energyData.filter(e => e.energyTransfer);

  for (const loser of energyLosers) {
    const loserEntity = entities.find(e => e.id === loser.entityId);
    if (!loserEntity) continue;

    for (const other of energyData) {
      if (other.entityId === loser.entityId) continue;
      const otherEntity = entities.find(e => e.id === other.entityId);
      if (!otherEntity) continue;

      const dx = loserEntity.kalman.getState().x - otherEntity.kalman.getState().x;
      const dy = loserEntity.kalman.getState().y - otherEntity.kalman.getState().y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const combinedSize = (Math.sqrt(loserEntity.w * loserEntity.h) + Math.sqrt(otherEntity.w * otherEntity.h)) / 2;

      if (distance > combinedSize * 2) continue;

      const severity = Math.min(1.0, loser.energyChange / 5);
      transfers.push({ a: loser.entityId, b: otherEntity.id, severity });
    }
  }

  return transfers;
}
