window.MALL_DEFAULTS = {
  externalItemIds: ['ITEM_IridiumOre', 'ITEM_Lonsdaleite', 'ITEM_NitrogenGas'],
  targetItemIds: [
    'ITEM_EncodedSimulationMatrix', 'ITEM_SuperconductorCoil', 'ITEM_Superalloy', 'ITEM_HullPlates',
    'ITEM_MagneticCoils', 'ITEM_MaglevCoupling', 'ITEM_ServoPlates', 'ITEM_Servomotor', 'ITEM_Capacitor',
    'ITEM_Silica', 'ITEM_AdvancedCircuits', 'ITEM_BasicCircuit', 'ITEM_BasicMotor', 'ITEM_NickelPlates',
    'ITEM_ReinforcedPlates', 'ITEM_ReinforcedGlass', 'ITEM_LightweightFrame', 'ITEM_Biolattice',
    'ITEM_TitaniumPlates', 'ITEM_DetectorArray', 'ITEM_IridiumPlates', 'ITEM_RelicShard', 'ITEM_ContainmentCoil',
    'ITEM_SuperalloyFrame', 'ITEM_RelicCapacitor', 'ITEM_ChromaticAlloy', 'ITEM_EnrichedFuel', 'ITEM_WarpFuel',
    'ITEM_Coolant', 'ITEM_RepairKit', 'ITEM_RepairKitHull', 'ITEM_RepairKitElectric', 'ITEM_Missile',
    'ITEM_ChitinComposite', 'ITEM_Multisensor', 'ITEM_AdvancedPlates',
  ],
  manualOnlyItemIds: [
    'ITEM_BackpackMk1', 'ITEM_BackpackMk2', 'ITEM_BackpackMk3', 'ITEM_ExoskeletonMk1',
    'ITEM_ExoskeletonMk2', 'ITEM_ExoskeletonMk3', 'ITEM_Exosuit',
  ],
  recipeByItem: {
    ITEM_TitaniumPlates: 'REC_EnrichedTitaniumPlates',
    ITEM_NickelPlates: 'REC_EnrichedNickelPlates',
    ITEM_CobaltPlates: 'REC_EnrichedCobaltPlates',
    ITEM_WarpFuel: 'REC_WarpFuel',
    ITEM_MagneticCoils: 'REC_MagneticCoilsAlt1',
    ITEM_MaglevCoupling: 'REC_MaglevCouplingAlt',
    ITEM_ReinforcedPlates: 'REC_ReinforcedPlatesAlt',
  },
  zones: [
    { id: 'main', name: '主生产区', isolated: false },
    { id: 'energy', name: '能源区', isolated: true },
  ],
  energyItemIds: ['ITEM_Protomatter', 'ITEM_HydrogenFuel', 'ITEM_EnrichedFuel', 'ITEM_WarpFuel'],
};
