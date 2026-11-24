import { describe, expect, it } from 'vitest';
import { createEmptyBlueprint, placeBuildingCmd, placeModuleCmd } from './commands';
import { runHierarchicalVerification } from './verifier';

describe('Hierarchical Deterministic Verification Framework (HDVF v1.0)', () => {
  it('L0 catches incompatible recipe crafterId and out-of-range disabledPorts deterministically', () => {
    let doc = createEmptyBlueprint();
    doc = placeModuleCmd(doc, { type: 'BPO_Station_03', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    doc = placeBuildingCmd(doc, {
      type: 'DAT_Refinery',
      x: 10,
      y: 10,
      floor: 0,
      rotation: 0,
      recipeId: 'REC_Assembler', // Wrong machine! (CRAFT_Assembler != CRAFT_Refinery)
    }).doc;
    // Simulate corrupt / hand-edited JSON with out-of-range disabledPort index
    doc.buildings[0].disabledPorts = [99];

    const r = runHierarchicalVerification(doc, { skipUnitSim: true, skipProgressiveSaturation: true });
    expect(r.layer0.invalidRecipes).toBe(1);
    expect(r.layer0.invalidPortConfigs).toBe(1);
    expect(r.layer0.passed).toBe(false);
    expect(r.passed).toBe(false);
  });

  it('L1 deduplicates identical rotated module archetypes via collision-free canonical keys', () => {
    let doc = createEmptyBlueprint();
    // Place 4 identical 2x2 rooms rotated 0/1/2/3 with an identical centered container inside each
    const coords: Array<[number, number, 0 | 1 | 2 | 3]> = [
      [0, 0, 0],
      [2, 0, 1],
      [0, 2, 2],
      [2, 2, 3],
    ];
    for (const [gx, gy, rot] of coords) {
      doc = placeModuleCmd(doc, { type: 'BPO_Station_03', gx, gy, floor: 0, rotation: rot }).doc;
      doc = placeBuildingCmd(doc, {
        type: 'DAT_Container_2',
        x: gx * 16 + 14,
        y: gy * 16 + 14,
        floor: 0,
        rotation: rot,
      }).doc;
    }

    const r = runHierarchicalVerification(doc, { skipProgressiveSaturation: true });
    expect(r.layer1.floorBearingModuleCount).toBe(4);
    expect(r.layer1.uniqueArchetypeCount).toBe(1);
    expect(r.layer1.dedupSavingsRatio).toBeCloseTo(0.75, 2);
    expect(r.layer1.passed).toBe(true);
  });

  it('L2 separates Blueprint-Valid BlockBounds CheckOverlap from non-blocking Planner floating-module advisory', () => {
    // 1) Floating solar panel detached from main room -> Blueprint-Valid (passed=true), Planner advisory reports 1 floating module!
    let floatDoc = createEmptyBlueprint();
    floatDoc = placeModuleCmd(floatDoc, { type: 'BPO_Station_03', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    floatDoc = placeModuleCmd(floatDoc, { type: 'BPO_SolarPanelBlock_03', gx: 6, gy: 0, floor: 0, rotation: 0 }).doc;
    const rFloat = runHierarchicalVerification(floatDoc, { skipUnitSim: true, skipProgressiveSaturation: true });
    expect(rFloat.layer2.blockBoundsOverlapCount).toBe(0);
    expect(rFloat.layer2.plannerAdvisory.connectorComponents).toBe(2);
    expect(rFloat.layer2.plannerAdvisory.floatingModuleCount).toBe(1);
    expect(rFloat.layer2.passed).toBe(true);

    // 2) Overlapping BlockBounds (two BPO_SolarPanelBlock_03 stacked at L0 and L2 at same XY: Z∈[-19,+19] vs [-3,+35]) -> HARD FAIL!
    let clashDoc = createEmptyBlueprint();
    clashDoc = placeModuleCmd(clashDoc, { type: 'BPO_SolarPanelBlock_03', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    clashDoc = placeModuleCmd(clashDoc, { type: 'BPO_SolarPanelBlock_03', gx: 0, gy: 0, floor: 2, rotation: 0 }).doc;
    const rClash = runHierarchicalVerification(clashDoc, { skipUnitSim: true, skipProgressiveSaturation: true });
    expect(rClash.layer2.blockBoundsOverlapCount).toBe(1);
    expect(rClash.layer2.passed).toBe(false);
    expect(rClash.passed).toBe(false);
  });

  it('L3 models real-game no-trip proportional power speed scaling (low power slows down, never fails blueprint)', () => {
    let doc = createEmptyBlueprint();
    doc = placeModuleCmd(doc, { type: 'BPO_Station_03', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    // 1x SolarPanelBlock_02 (48 MW) + 3x RelicSynthesizer (3 x 54 MW = 162 MW -> ~29.6% speed, NO blackout!)
    doc = placeModuleCmd(doc, { type: 'BPO_SolarPanelBlock_02', gx: 4, gy: 0, floor: 0, rotation: 0 }).doc;
    for (let i = 0; i < 3; i++) {
      doc = placeBuildingCmd(doc, {
        type: 'DAT_RelicSynthesizer',
        x: 2 + i * 9,
        y: 6,
        floor: 0,
        rotation: 0,
        recipeId: 'REC_Protomatter',
        disabledPorts: [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11],
      }).doc;
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x: 6 + i * 9, y: 15, floor: 0, rotation: 1 }).doc;
      doc = placeBuildingCmd(doc, { type: 'DAT_Container', x: 6 + i * 9, y: 16, floor: 0, rotation: 0 }).doc;
    }

    const r = runHierarchicalVerification(doc, { skipUnitSim: true, skipProgressiveSaturation: true });
    const fullLight = r.layer3.orbitProfiles.find((o) => o.solarFactor === 1.0)!;
    expect(fullLight.supplyMW).toBeCloseTo(48, 1);
    expect(fullLight.peakSpeedScale).toBeCloseTo(48 / 162, 2);
    expect(r.layer3.passed).toBe(true);
    expect(r.passed).toBe(true);
  });

  it('L4 proves progressive saturation backpressure reachability across registration-order elevator strata', () => {
    // 1x Protomatter (1.0/s) pushed into L2 elevator shaft;
    // L0 (registered BEFORE L4) has 2x SilicaSynthesis (2 x 0.5/s = 1.0/s -> drains 100% on Stratum 0, starving L4!);
    // Once L0's terminal Silica box saturates in Stratum 1, L0 crafters backpressure to 0 and L4 showcase box receives 1.0/s!
    let doc = createEmptyBlueprint();
    doc = placeModuleCmd(doc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    doc = placeModuleCmd(doc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 2, rotation: 0 }).doc;
    doc = placeModuleCmd(doc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 4, rotation: 0 }).doc;
    doc = placeModuleCmd(doc, { type: 'BPO_Station_03', gx: -2, gy: 0, floor: 0, rotation: 0 }).doc;
    doc = placeModuleCmd(doc, { type: 'BPO_Station_03', gx: -2, gy: 0, floor: 2, rotation: 0 }).doc;

    // L2 producer: 1x RelicSynthesizer -> Protomatter 1.0/s into elevator west port (6,10)
    doc = placeBuildingCmd(doc, {
      type: 'DAT_RelicSynthesizer',
      x: -13,
      y: 6,
      floor: 2,
      rotation: 0,
      recipeId: 'REC_Protomatter',
      disabledPorts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    }).doc;
    for (let x = -4; x <= 6; x++) {
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x, y: 10, floor: 2, rotation: 0 }).doc;
    }

    // L0 high-priority consumer: 2x SilicaSynthesis consuming exact 1.0/s Protomatter -> terminal box at L0!
    for (let x = 6; x >= -3; x--) {
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x, y: 10, floor: 0, rotation: 2 }).doc;
    }
    // Split at (-2, 10) into 2x EnrichmentChamber (y=6 and y=16)
    doc.buildings = doc.buildings.map((b) =>
      b.floor === 0 && b.x === -2 && b.y === 10
        ? { ...b, type: 'DAT_Splitter_3', disabledPorts: [1] }
        : b
    );
    // Chamber 1 at (-12, 6) fed via (-3,10) -> outputs West at (-13, 10) -> box1 at (-15, 9)
    doc = placeBuildingCmd(doc, {
      type: 'DAT_EnrichmentChamber',
      x: -12,
      y: 6,
      floor: 0,
      rotation: 0,
      recipeId: 'REC_SilicaSynthesis',
      disabledPorts: [1, 2, 3, 4, 5, 7, 8, 9, 10, 11],
    }).doc;
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x: -13, y: 10, floor: 0, rotation: 2 }).doc;
    doc = placeBuildingCmd(doc, { type: 'DAT_Container', x: -15, y: 9, floor: 0, rotation: 0 }).doc;
    // Chamber 2 at (-12, 16) fed from splitter South branch (-2,11..19 South -> -2,20 West -> -3,20 West) -> box2 at (-15, 19)
    for (let y = 11; y <= 19; y++) {
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x: -2, y, floor: 0, rotation: 1 }).doc;
    }
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x: -2, y: 20, floor: 0, rotation: 2 }).doc;
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x: -3, y: 20, floor: 0, rotation: 2 }).doc;
    doc = placeBuildingCmd(doc, {
      type: 'DAT_EnrichmentChamber',
      x: -12,
      y: 16,
      floor: 0,
      rotation: 0,
      recipeId: 'REC_SilicaSynthesis',
      disabledPorts: [1, 2, 3, 4, 5, 7, 8, 9, 10, 11],
    }).doc;
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x: -13, y: 20, floor: 0, rotation: 2 }).doc;
    doc = placeBuildingCmd(doc, { type: 'DAT_Container', x: -15, y: 19, floor: 0, rotation: 0 }).doc;

    // L4 lower-priority showcase box (starved on Stratum 0, reached on Stratum 1 once L0 saturates!)
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x: 6, y: 10, floor: 4, rotation: 2 }).doc;
    doc = placeBuildingCmd(doc, { type: 'DAT_Container', x: 4, y: 9, floor: 4, rotation: 0 }).doc;

    const r = runHierarchicalVerification(doc, { skipUnitSim: true });
    expect(r.layer4.activeProducerBackedSinkCount).toBe(3);
    expect(r.layer4.coldStartReachedSinkCount).toBe(2); // Only the 2 L0 Silica boxes on Stratum 0!
    expect(r.layer4.eventuallyReachedSinkCount).toBe(3); // L4 showcase box reached on Stratum 1!
    expect(r.layer4.strata.length).toBe(2);
    expect(r.layer4.strata[1].newlyReachedSinkIds.length).toBe(1);
    expect(r.layer4.backpressureRegressionCount).toBe(0);
    expect(r.layer4.passed).toBe(true);
    expect(r.passed).toBe(true);
  });

  it('L4 fails hard when a non-conserved terminal storage sink remains permanently unreachable across all strata', () => {
    // Disconnected elevator gap (L0 + L4, missing L2!) feeding an L4 showcase box -> unreachable even after saturation!
    let doc = createEmptyBlueprint();
    doc = placeModuleCmd(doc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    doc = placeModuleCmd(doc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 4, rotation: 0 }).doc;
    doc = placeModuleCmd(doc, { type: 'BPO_Station_03', gx: -2, gy: 0, floor: 0, rotation: 0 }).doc;
    doc = placeBuildingCmd(doc, {
      type: 'DAT_RelicSynthesizer',
      x: -13,
      y: 6,
      floor: 0,
      rotation: 0,
      recipeId: 'REC_Protomatter',
      disabledPorts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    }).doc;
    for (let x = -4; x <= 6; x++) {
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x, y: 10, floor: 0, rotation: 0 }).doc;
    }
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x: 6, y: 10, floor: 4, rotation: 2 }).doc;
    doc = placeBuildingCmd(doc, { type: 'DAT_Container', x: 4, y: 9, floor: 4, rotation: 0 }).doc;

    const r = runHierarchicalVerification(doc, { skipUnitSim: true });
    expect(r.layer2.elevatorStackGaps).toBeGreaterThan(0);
    expect(r.layer2.passed).toBe(false);
    expect(r.passed).toBe(false);
  });
});
