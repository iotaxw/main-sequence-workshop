import React from 'react';

/**
 * Monochrome architectural line-art SVG glyphs for the compact shapez-2-inspired dock.
 * Matches the 3D planar line-art silhouettes 1-to-1!
 */
export const EntityGlyph: React.FC<{ id: string; size?: number }> = ({ id, size = 24 }) => {
  const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const dim = { ...s, strokeOpacity: 0.45, strokeWidth: 1.05 };

  const renderShape = () => {
    // Belts
    if (id.startsWith('DAT_ConveyorBelt')) {
      const tier = id.endsWith('3') ? 3 : id.endsWith('2') ? 2 : 1;
      return (
        <>
          <line x1="3" y1="8" x2="21" y2="8" {...dim} />
          <line x1="3" y1="16" x2="21" y2="16" {...dim} />
          {tier === 1 && <polyline points="10,9.5 14,12 10,14.5" {...s} />}
          {tier === 2 && (
            <>
              <polyline points="8,9.5 11.5,12 8,14.5" {...s} />
              <polyline points="13,9.5 16.5,12 13,14.5" {...s} />
            </>
          )}
          {tier === 3 && (
            <>
              <polyline points="6.5,9.5 9.5,12 6.5,14.5" {...s} />
              <polyline points="11,9.5 14,12 11,14.5" {...s} />
              <polyline points="15.5,9.5 18.5,12 15.5,14.5" {...s} />
            </>
          )}
        </>
      );
    }

    // Underground belts (tier ticks 1/2/3)
    if (id.startsWith('DAT_UndergroundBelt')) {
      const tier = id.endsWith('3') ? 3 : id.endsWith('2') ? 2 : 1;
      return (
        <>
          <polyline points="8,6 19,6 19,18 8,18" {...s} />
          <line x1="15" y1="8.5" x2="15" y2="15.5" {...dim} />
          <polyline points="5,9.5 9.5,12 5,14.5" {...s} />
          {tier >= 2 && <line x1="11.5" y1="9.5" x2="11.5" y2="14.5" {...dim} />}
          {tier === 3 && <line x1="17" y1="9.5" x2="17" y2="14.5" {...dim} />}
        </>
      );
    }

    // Splitters (tier ticks 1/2/3)
    if (id.startsWith('DAT_Splitter')) {
      const tier = id.endsWith('3') ? 3 : id.endsWith('2') ? 2 : 1;
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" {...dim} />
          <line x1="4" y1="12" x2="19" y2="12" {...s} />
          <line x1="12" y1="5" x2="12" y2="19" {...s} />
          <polyline points="15.5,9.5 18.5,12 15.5,14.5" {...s} />
          {tier >= 2 && <circle cx="7.5" cy="7.5" r="0.9" {...s} />}
          {tier === 3 && <circle cx="7.5" cy="16.5" r="0.9" {...s} />}
        </>
      );
    }

    // Belt Balancers (tier bar lines 1/2/3)
    if (id.startsWith('DAT_BeltBalancer')) {
      const tier = id.endsWith('03') ? 3 : id.endsWith('02') ? 2 : 1;
      return (
        <>
          <rect x="5" y="3" width="14" height="18" rx="2" {...dim} />
          <line x1="5" y1="7.5" x2="19" y2="16.5" {...s} />
          <line x1="5" y1="16.5" x2="19" y2="7.5" {...s} />
          {tier >= 2 && <line x1="7.5" y1="5.2" x2="16.5" y2="5.2" {...dim} />}
          {tier === 3 && <line x1="7.5" y1="18.8" x2="16.5" y2="18.8" {...dim} />}
        </>
      );
    }

    // Containers
    if (id === 'DAT_Container' || id === 'DAT_Container_2') {
      const big = id === 'DAT_Container_2';
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" {...s} />
          {big ? (
            <>
              <line x1="9.3" y1="4.5" x2="9.3" y2="19.5" {...dim} />
              <line x1="14.7" y1="4.5" x2="14.7" y2="19.5" {...dim} />
              <line x1="4.5" y1="9.3" x2="19.5" y2="9.3" {...dim} />
              <line x1="4.5" y1="14.7" x2="19.5" y2="14.7" {...dim} />
            </>
          ) : (
            <>
              <line x1="12" y1="5" x2="12" y2="19" {...dim} />
              <line x1="5" y1="12" x2="19" y2="12" {...dim} />
            </>
          )}
        </>
      );
    }

    // Production machines
    if (id === 'DAT_Refinery') {
      return (
        <>
          <polygon points="7,4 17,4 20,7 20,17 17,20 7,20 4,17 4,7" {...s} />
          <circle cx="12" cy="12" r="4.2" {...s} />
          <line x1="6" y1="6" x2="9" y2="9" {...dim} />
          <line x1="18" y1="6" x2="15" y2="9" {...dim} />
          <line x1="6" y1="18" x2="9" y2="15" {...dim} />
          <line x1="18" y1="18" x2="15" y2="15" {...dim} />
        </>
      );
    }
    if (id === 'DAT_Assembler') {
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2.5" {...s} />
          <rect x="7" y="7" width="10" height="10" rx="1" {...dim} />
          <polygon points="12,8.5 15.5,12 12,15.5 8.5,12" {...s} />
        </>
      );
    }
    if (id === 'DAT_AdvancedAssembler') {
      return (
        <>
          <polygon points="7,3.5 17,3.5 20.5,7 20.5,17 17,20.5 7,20.5 3.5,17 3.5,7" {...s} />
          <line x1="5" y1="12" x2="19" y2="12" {...dim} />
          <line x1="12" y1="5" x2="12" y2="19" {...dim} />
          <polygon points="12,7 17,12 12,17 7,12" {...s} />
        </>
      );
    }
    if (id === 'DAT_EnrichmentChamber') {
      return (
        <>
          <polygon points="7.5,3.5 16.5,3.5 20.5,7.5 20.5,16.5 16.5,20.5 7.5,20.5 3.5,16.5 3.5,7.5" {...dim} />
          <circle cx="12" cy="12" r="6.8" {...s} />
          <circle cx="12" cy="12" r="3.6" {...dim} />
          <circle cx="12" cy="12" r="1.4" {...s} />
        </>
      );
    }
    if (id === 'DAT_Supercomputer') {
      return (
        <>
          <rect x="3.5" y="4" width="17" height="16" rx="2" {...s} />
          <line x1="7" y1="7" x2="7" y2="17" {...dim} />
          <line x1="10.3" y1="7" x2="10.3" y2="17" {...dim} />
          <line x1="13.7" y1="7" x2="13.7" y2="17" {...dim} />
          <line x1="17" y1="7" x2="17" y2="17" {...dim} />
          <line x1="4" y1="12" x2="20" y2="12" {...s} />
        </>
      );
    }
    if (id === 'DAT_GrowthChamber') {
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="4" {...dim} />
          <polygon points="12,5.5 17.6,8.8 17.6,15.2 12,18.5 6.4,15.2 6.4,8.8" {...s} />
          <circle cx="12" cy="12" r="2.2" {...dim} />
        </>
      );
    }
    if (id === 'DAT_RelicSynthesizer') {
      return (
        <>
          <polygon points="12,3.5 20.5,12 12,20.5 3.5,12" {...s} />
          <rect x="6.5" y="6.5" width="11" height="11" {...dim} />
          <circle cx="12" cy="12" r="2.2" {...s} />
        </>
      );
    }
    if (id === 'DAT_ReactorMachine') {
      return (
        <>
          <polygon points="8,4 16,4 20,8 20,16 16,20 8,20 4,16 4,8" {...s} />
          <circle cx="12" cy="12" r="2.4" {...s} />
          <line x1="12" y1="9.6" x2="12" y2="5" {...dim} />
          <line x1="14.1" y1="13.2" x2="18" y2="15.5" {...dim} />
          <line x1="9.9" y1="13.2" x2="6" y2="15.5" {...dim} />
        </>
      );
    }
    if (id === 'DAT_MatSciLab') {
      // Lab I: Material Science (single crystal ring + crosshair)
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2.5" {...dim} />
          <circle cx="12" cy="12" r="4.8" {...s} />
          <line x1="6.5" y1="12" x2="17.5" y2="12" {...dim} />
          <line x1="12" y1="6.5" x2="12" y2="17.5" {...dim} />
        </>
      );
    }
    if (id === 'DAT_CompSciLab') {
      // Lab II: Computer Science (concentric square core + bus ticks)
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2.5" {...dim} />
          <rect x="8" y="8" width="8" height="8" rx="1" {...s} />
          <line x1="12" y1="4.5" x2="12" y2="8" {...dim} />
          <line x1="12" y1="16" x2="12" y2="19.5" {...dim} />
          <line x1="4.5" y1="12" x2="8" y2="12" {...dim} />
          <line x1="16" y1="12" x2="19.5" y2="12" {...dim} />
        </>
      );
    }
    if (id === 'DAT_ElectroSciLab') {
      // Lab III: Electro Science (diamond coil inside ring)
      return (
        <>
          <circle cx="12" cy="12" r="7.2" {...dim} />
          <polygon points="12,6.5 17.5,12 12,17.5 6.5,12" {...s} />
          <circle cx="12" cy="12" r="1.5" {...s} />
        </>
      );
    }
    if (id === 'DAT_QuantumSciLab') {
      // Lab IV: Quantum Science (dual orbital ellipses + nucleus)
      return (
        <>
          <ellipse cx="12" cy="12" rx="7.6" ry="3.4" transform="rotate(40 12 12)" {...s} />
          <ellipse cx="12" cy="12" rx="7.6" ry="3.4" transform="rotate(-40 12 12)" {...dim} />
          <circle cx="12" cy="12" r="1.6" {...s} />
        </>
      );
    }
    if (id === 'DAT_AstroSciLab') {
      // Lab V: Astro Science (celestial ring + 4-point star)
      return (
        <>
          <circle cx="12" cy="12" r="7.4" {...dim} />
          <polygon points="12,5 13.7,10.3 19,12 13.7,13.7 12,19 10.3,13.7 5,12 10.3,10.3" {...s} />
        </>
      );
    }
    if (id === 'DAT_XenoSciLab') {
      // Lab VI: Xeno Science (outer hex + inner tri-core)
      return (
        <>
          <polygon points="12,4 19,8 19,16 12,20 5,16 5,8" {...s} />
          <polygon points="12,7.5 16,14.5 8,14.5" {...dim} />
          <circle cx="12" cy="12.2" r="1.2" {...s} />
        </>
      );
    }
    if (id === 'DAT_RelicAnalyzer') {
      // Relic Analyzer (octagonal chamber + scan axis)
      return (
        <>
          <polygon points="8,4 16,4 20,8 20,16 16,20 8,20 4,16 4,8" {...dim} />
          <polygon points="12,7 16.5,12 12,17 7.5,12" {...s} />
          <line x1="4.5" y1="12" x2="19.5" y2="12" {...dim} />
        </>
      );
    }
    if (id === 'DAT_Teleporter') {
      return (
        <>
          <circle cx="12" cy="12" r="7.5" {...s} />
          <circle cx="12" cy="12" r="4.5" {...dim} />
          <circle cx="12" cy="12" r="1.6" {...s} />
        </>
      );
    }

    // Station Modules
    if (id === 'BPO_Station_02') {
      // 2x2 B with ring balcony hole!
      return (
        <>
          <rect x="3.5" y="3.5" width="17" height="17" rx="2" {...s} />
          <rect x="7.5" y="7.5" width="9" height="9" rx="1" {...dim} />
        </>
      );
    }
    if (id === 'BPO_Station_03') {
      // 2x2 C wide XLarge openings
      return (
        <>
          <path d="M4,8 V4 H8 M16,4 H20 V8 M20,16 V20 H16 M8,20 H4 V16" {...s} />
          <rect x="6.5" y="6.5" width="11" height="11" {...dim} />
        </>
      );
    }
    if (id === 'BPO_Station_2x1' || id === 'BPO_StationAdapter_01') {
      return (
        <>
          <rect x="3" y="6.5" width="18" height="11" rx="1.8" {...s} />
          <line x1="12" y1="7" x2="12" y2="17" {...dim} />
        </>
      );
    }
    if (id.includes('Corridor')) {
      return (
        <>
          <line x1="3" y1="7.5" x2="21" y2="7.5" {...s} />
          <line x1="3" y1="16.5" x2="21" y2="16.5" {...s} />
          <line x1="6" y1="12" x2="18" y2="12" {...dim} />
        </>
      );
    }
    if (id.includes('Corner')) {
      // Symmetric 45° panoramic bevel corner (W & S connectors, chamfered NE glass wall)
      return (
        <>
          <polygon points="4,4 9.5,4 20,14.5 20,20 4,20" {...s} />
          <line x1="9.5" y1="6.5" x2="17.5" y2="14.5" {...dim} />
        </>
      );
    }
    if (id.includes('Elevator')) {
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" {...dim} />
          <polygon points="12,6.5 17.5,12 12,17.5 6.5,12" {...s} />
          <polyline points="10,11 12,9 14,11" {...s} />
          <polyline points="10,13 12,15 14,13" {...s} />
        </>
      );
    }
    if (id.includes('Solar')) {
      return (
        <>
          <rect x="3.5" y="6" width="17" height="12" rx="1.5" {...s} />
          <line x1="9" y1="6.5" x2="9" y2="17.5" {...dim} />
          <line x1="15" y1="6.5" x2="15" y2="17.5" {...dim} />
          <line x1="4" y1="12" x2="20" y2="12" {...dim} />
        </>
      );
    }
    if (id === 'BPO_StationArmour_01') {
      // Upper roof armour cap (16x16 beveled top plate + upward indicator)
      return (
        <>
          <polygon points="6.5,4 17.5,4 20,6.5 20,17.5 17.5,20 6.5,20 4,17.5 4,6.5" {...s} />
          <rect x="8" y="8" width="8" height="8" rx="1" {...dim} />
          <polyline points="9.5,13 12,10.2 14.5,13" {...s} />
        </>
      );
    }
    if (id === 'BPO_StationArmour_01B') {
      // Lower belly armour cap (vertically flipped mirror of 01 + downward indicator)
      return (
        <>
          <polygon points="6.5,4 17.5,4 20,6.5 20,17.5 17.5,20 6.5,20 4,17.5 4,6.5" {...dim} />
          <rect x="7.5" y="7.5" width="9" height="9" rx="1" {...s} />
          <polyline points="9.5,11 12,13.8 14.5,11" {...s} />
        </>
      );
    }
    if (id === 'BPO_StationTurretBlock_01') {
      // Octagonal turret base + twin plasma barrels
      return (
        <>
          <polygon points="7,7 14,7 16.5,9.5 16.5,14.5 14,17 7,17 4.5,14.5 4.5,9.5" {...dim} />
          <circle cx="10.5" cy="12" r="3" {...s} />
          <line x1="13.5" y1="10.5" x2="20.5" y2="10.5" {...s} />
          <line x1="13.5" y1="13.5" x2="20.5" y2="13.5" {...s} />
        </>
      );
    }
    if (id === 'BPO_CommandModule') {
      return (
        <>
          <polygon points="12,3.5 19.5,8 19.5,16 12,20.5 4.5,16 4.5,8" {...s} />
          <circle cx="12" cy="12" r="3" {...dim} />
          <line x1="12" y1="6.5" x2="12" y2="9" {...s} />
        </>
      );
    }
    if (id === 'BPO_Dock') {
      return (
        <>
          <rect x="4" y="6" width="6" height="12" rx="1" {...s} />
          <path d="M10,7 H19 M10,17 H19" {...s} />
          <line x1="11" y1="12" x2="18" y2="12" {...dim} />
        </>
      );
    }
    if (id === 'BPO_Dock_2') {
      // Industrial Dock 3x2: west indoor factory bay + wide east open freighter gantry arms
      return (
        <>
          <rect x="3.5" y="4.5" width="6.5" height="15" rx="1" {...s} />
          <path d="M10,5.5 H20.5 V8 H10 M10,16 H20.5 V18.5 H10" {...s} />
          <line x1="12" y1="12" x2="19.5" y2="12" {...dim} />
        </>
      );
    }
    if (id === 'BPO_ScannerModule') {
      return (
        <>
          <circle cx="12" cy="12" r="7.5" {...dim} />
          <path d="M7.5,14.5 A6,6 0 0,1 16.5,9.5" {...s} />
          <circle cx="12" cy="12" r="1.5" {...s} />
        </>
      );
    }
    if (id.includes('MiningDrone')) {
      const mk2 = id.endsWith('_2');
      return (
        <>
          <rect x="4" y="4.5" width="16" height="15" rx="2" {...s} />
          <rect x="7.5" y="8" width="9" height="8" rx="1" {...dim} />
          {mk2 ? (
            <>
              <line x1="12" y1="8" x2="12" y2="16" {...s} />
              <line x1="7.5" y1="12" x2="16.5" y2="12" {...s} />
            </>
          ) : (
            <line x1="12" y1="8.5" x2="12" y2="15.5" {...s} />
          )}
        </>
      );
    }
    if (id === 'BPO_DeepSpaceObservatory') {
      return (
        <>
          <circle cx="12" cy="12" r="7.6" {...s} />
          <line x1="12" y1="4.4" x2="12" y2="19.6" {...dim} />
          <circle cx="12" cy="12" r="3" {...dim} />
        </>
      );
    }
    if (id.includes('Shipyard')) {
      return (
        <>
          <path d="M4,6 H20 M4,18 H20 M6,6 V18 M18,6 V18" {...s} />
          <line x1="12" y1="6" x2="12" y2="18" {...dim} />
        </>
      );
    }

    // === Ship Modules (1:1 matched to 3D top-down CAD silhouettes; default bow faces LEFT <-) ===
    if (id.startsWith('BPO_Cockpit_')) {
      const big = id !== 'BPO_Cockpit_01';
      return (
        <g transform="rotate(180 12 12)">
          <polygon points="4,6.5 14,6.5 20.5,10 20.5,14 14,17.5 4,17.5" {...s} />
          <polyline points="12.5,8.5 17,12 12.5,15.5" {...dim} />
          {big && <line x1="8" y1="7" x2="8" y2="17" {...dim} />}
        </g>
      );
    }
    if (id === 'BPO_DockingCollar') {
      return (
        <>
          <rect x="4" y="6" width="16" height="8" rx="1.5" {...s} />
          <circle cx="12" cy="10" r="2.2" {...s} />
          <line x1="7" y1="17" x2="17" y2="17" {...dim} />
        </>
      );
    }
    if (id === 'BPO_Body_01' || id === 'BPO_Body_02') {
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2.5" {...s} />
          <rect x="7.5" y="7.5" width="9" height="9" rx="1" {...dim} />
          {id === 'BPO_Body_02' && <line x1="6" y1="20" x2="18" y2="20" strokeWidth={2.2} stroke="currentColor" />}
        </>
      );
    }
    if (id === 'BPO_ShipCorner_01') {
      return (
        <>
          <polygon points="4,4 20,4 20,10 10,20 4,20" {...s} />
          <line x1="18.5" y1="11.5" x2="11.5" y2="18.5" {...dim} />
        </>
      );
    }
    if (id === 'BPO_WindowBlock') {
      return (
        <>
          <rect x="6" y="5" width="7" height="14" rx="1.5" {...s} />
          <line x1="13" y1="8" x2="18" y2="8" {...dim} />
          <line x1="13" y1="16" x2="18" y2="16" {...dim} />
        </>
      );
    }
    if (id === 'BPO_Frame_01' || id.startsWith('BPO_FrameSlope_')) {
      return (
        <g transform="rotate(180 12 12)">
          {id === 'BPO_Frame_01' ? (
            <>
              {/* Real open cross-shaped (+) tubular corridor */}
              <polygon points="9,4 15,4 15,9 20,9 20,15 15,15 15,20 9,20 9,15 4,15 4,9 9,9" {...s} />
              <rect x="9.5" y="9.5" width="5" height="5" rx="1" {...dim} />
            </>
          ) : (
            <>
              {/* Real cantilever triangular frame slope */}
              <path d="M5,7 V17 H10 L19,14 V10 L10,7 Z" {...s} />
              <line x1="9" y1="8.5" x2="17" y2="12" {...dim} />
            </>
          )}
        </g>
      );
    }
    if (id === 'BPO_LadderBlock') {
      return (
        <>
          <rect x="4.5" y="4.5" width="15" height="15" rx="2" {...dim} />
          <line x1="9" y1="5.5" x2="9" y2="18.5" {...s} />
          <line x1="15" y1="5.5" x2="15" y2="18.5" {...s} />
          <line x1="9" y1="9" x2="15" y2="9" {...s} />
          <line x1="9" y1="12" x2="15" y2="12" {...s} />
          <line x1="9" y1="15" x2="15" y2="15" {...s} />
        </>
      );
    }
    if (id === 'BPO_LandingGear_01') {
      return (
        <>
          <line x1="4" y1="12" x2="20" y2="12" {...dim} />
          <rect x="8.5" y="4.5" width="7" height="4.5" rx="1" {...s} />
          <rect x="8.5" y="15" width="7" height="4.5" rx="1" {...s} />
          <line x1="12" y1="9" x2="12" y2="15" {...s} />
        </>
      );
    }
    if (id.startsWith('BPO_Thruster_')) {
      const large = id === 'BPO_Thruster_05';
      const med = id === 'BPO_Thruster_03';
      const relic = id.startsWith('BPO_Thruster_04');
      const isLeft = id.endsWith('L');
      // Bow points LEFT; for Right (Starboard) mount sits on bottom edge (hull below), Left (Port) flips vertically
      const xform = isLeft ? 'translate(0 24) scale(1 -1) rotate(180 12 12)' : 'rotate(180 12 12)';
      return (
        <g transform={xform}>
          {relic ? (
            <>
              {/* Real 18m relic thruster: flat mount rail along inner side, curved cowl outboard */}
              <path d="M3.5,15.5 L17,15.5 L20,12.5 Q19,8 14.5,7.5 L7.5,8.5 L5,10.8 L8.5,12.5 L3.5,14 Z" {...s} />
              <line x1="2.5" y1="10.8" x2="7.5" y2="10.8" {...s} />
              <line x1="3" y1="13.8" x2="7.5" y2="13.8" {...s} />
              <rect x="11" y="6.2" width="9.5" height="10.2" rx="1" strokeDasharray="2 1.5" {...dim} />
            </>
          ) : large ? (
            <>
              <rect x="9.5" y="4.5" width="10.5" height="15" rx="1.8" {...s} />
              <polygon points="4.5,6 9.5,5.5 9.5,9 4.5,8.5" {...s} />
              <polygon points="4,10.5 9.5,10 9.5,14 4,13.5" {...s} />
              <polygon points="4.5,15.5 9.5,15 9.5,18.5 4.5,18" {...s} />
            </>
          ) : med ? (
            <>
              <path d="M8.5,7 H19.5 Q20.5,12 19.5,17 H8.5 Z" {...s} />
              <polygon points="3.5,9 8.5,8 8.5,16 3.5,15" {...s} />
              <line x1="12" y1="12" x2="18.5" y2="12" {...dim} />
            </>
          ) : (
            <>
              {/* Real side-pod small thruster: flat mount rail on inner side, twin stepped cones */}
              <path d="M8,15.5 L18.5,15.5 L19.8,12.2 Q19.2,8.5 15,8 L8,9 Z" {...s} />
              <line x1="3.5" y1="10.6" x2="8" y2="10.6" {...s} />
              <line x1="4.5" y1="13.8" x2="8" y2="13.8" {...s} />
              <rect x="11.5" y="6.8" width="8.8" height="9.8" rx="1" strokeDasharray="2 1.5" {...dim} />
            </>
          )}
        </g>
      );
    }
    if (id === 'BPO_ReactorBlock_Small') {
      // Real D-shaped semicircular hull (flat +X bow, curved -X stern) with solid circular fusion cap
      return (
        <g transform="rotate(180 12 12)">
          <path d="M19,5 H11.5 A7,7 0 0,0 11.5,19 H19 Z" {...s} />
          <circle cx="13.2" cy="12" r="3.4" {...s} />
          <circle cx="13.2" cy="12" r="1.2" {...dim} />
        </g>
      );
    }
    if (id === 'BPO_WarpDriveBlock' || id === 'BPO_InterstellarWarpDriveBlock') {
      // Real D-shaped semicircular hull with large HOLLOW toroidal warp ring (vs solid-core Reactor!)
      const inter = id === 'BPO_InterstellarWarpDriveBlock';
      return (
        <g transform="rotate(180 12 12)">
          {inter ? (
            <>
              <rect x="5" y="4" width="14" height="16" rx="1.5" {...s} />
              <circle cx="12" cy="12" r="5" {...s} />
              <circle cx="12" cy="12" r="2.4" {...dim} />
            </>
          ) : (
            <>
              <path d="M19,5 H11.5 A7,7 0 0,0 11.5,19 H19 Z" {...s} />
              <circle cx="12.2" cy="12" r="5.2" {...dim} />
              <circle cx="12.2" cy="12" r="2.7" {...s} />
            </>
          )}
        </g>
      );
    }
    if (id === 'BPO_ShipContainerBlock') {
      // Real twin parallel cargo racks with central walkway corridor
      return (
        <>
          <rect x="4" y="4.5" width="16" height="5.2" rx="1" {...s} />
          <rect x="4" y="14.3" width="16" height="5.2" rx="1" {...s} />
          <line x1="8" y1="4.5" x2="8" y2="9.7" {...dim} />
          <line x1="12" y1="4.5" x2="12" y2="9.7" {...dim} />
          <line x1="16" y1="4.5" x2="16" y2="9.7" {...dim} />
          <line x1="8" y1="14.3" x2="8" y2="19.5" {...dim} />
          <line x1="12" y1="14.3" x2="12" y2="19.5" {...dim} />
          <line x1="16" y1="14.3" x2="16" y2="19.5" {...dim} />
        </>
      );
    }
    if (id === 'BPO_WorkstationBlock') {
      // Real half-depth trapezoidal workstation bay
      return (
        <g transform="rotate(180 12 12)">
          <polygon points="4.5,13 19.5,13 17.5,20 6.5,20" {...s} />
          <circle cx="12" cy="16.5" r="1.8" {...dim} />
        </g>
      );
    }
    if (id === 'BPO_Hangar_2') {
      return (
        <g transform="rotate(180 12 12)">
          <rect x="3.5" y="4" width="17" height="16" rx="2" {...s} />
          <rect x="6.5" y="7" width="11" height="10" rx="1" {...dim} />
          <polyline points="10.5,9.5 14,12 10.5,14.5" {...s} />
        </g>
      );
    }
    if (id === 'BPO_AstronomicScanner' || id === 'BPO_BiosampleCollector') {
      return (
        <g transform="rotate(180 12 12)">
          <rect x="5" y="4.5" width="14" height="15" rx="1.5" {...s} />
          {id === 'BPO_AstronomicScanner' ? (
            <>
              <path d="M18.5,7 A5.5,5.5 0 0,0 18.5,17" {...s} />
              <line x1="8" y1="12" x2="16" y2="12" {...dim} />
            </>
          ) : (
            <>
              <line x1="14" y1="7" x2="20" y2="7" {...s} />
              <line x1="14" y1="10.3" x2="20" y2="10.3" {...s} />
              <line x1="14" y1="13.7" x2="20" y2="13.7" {...s} />
              <line x1="14" y1="17" x2="20" y2="17" {...s} />
            </>
          )}
        </g>
      );
    }
    if (id.startsWith('BPO_CannonBlock')) {
      return (
        <g transform="rotate(180 12 12)">
          <rect x="4" y="7.5" width="8.5" height="9" rx="1.8" {...s} />
          <line x1="12.5" y1="9.6" x2="21" y2="9.6" {...s} />
          <line x1="12.5" y1="14.4" x2="21" y2="14.4" {...s} />
        </g>
      );
    }
    if (id.startsWith('BPO_MiningLaserBlock')) {
      // Real thick single central mining barrel with dorsal radiator ribs
      return (
        <g transform="rotate(180 12 12)">
          <rect x="4.5" y="7.8" width="8" height="8.4" rx="1.6" {...s} />
          <rect x="12.5" y="10.2" width="8.5" height="3.6" rx="0.8" {...s} />
          <line x1="7.5" y1="9" x2="7.5" y2="15" {...dim} />
          <line x1="10.5" y1="9" x2="10.5" y2="15" {...dim} />
        </g>
      );
    }
    if (id === 'BPO_LanceBlock') {
      // Real sleek narrow spinal lance
      return (
        <g transform="rotate(180 12 12)">
          <rect x="3" y="9" width="6" height="6" rx="1" {...s} />
          <rect x="9" y="10.6" width="12.2" height="2.8" rx="0.6" {...s} />
          <line x1="12" y1="12" x2="19" y2="12" {...dim} />
        </g>
      );
    }
    if (id === 'BPO_MissileLauncherBlock_01') {
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" {...dim} />
          <circle cx="9" cy="9" r="2" {...s} />
          <circle cx="15" cy="9" r="2" {...s} />
          <circle cx="9" cy="15" r="2" {...s} />
          <circle cx="15" cy="15" r="2" {...s} />
        </>
      );
    }
    if (id.startsWith('BPO_ShipLaserTurretBlock')) {
      // Real 6-petal radial star Point Defence turret!
      return (
        <>
          <circle cx="12" cy="12" r="3.4" {...s} />
          <line x1="12" y1="4.2" x2="12" y2="8.4" {...s} />
          <line x1="12" y1="15.6" x2="12" y2="19.8" {...s} />
          <line x1="5.2" y1="8.1" x2="8.9" y2="10.2" {...s} />
          <line x1="15.1" y1="13.8" x2="18.8" y2="15.9" {...s} />
          <line x1="5.2" y1="15.9" x2="8.9" y2="13.8" {...s} />
          <line x1="15.1" y1="10.2" x2="18.8" y2="8.1" {...s} />
        </>
      );
    }
    if (id.startsWith('BPO_TractorBeamBlock')) {
      // Real compact square base + centered circular tractor dish
      return (
        <g transform="rotate(180 12 12)">
          <rect x="5.5" y="6.5" width="12.5" height="11" rx="2" {...s} />
          <circle cx="12.5" cy="12" r="3.2" {...s} />
          <circle cx="12.5" cy="12" r="1.2" {...dim} />
        </g>
      );
    }
    if (id.startsWith('BPO_ShipShieldGenerator_01')) {
      // Real flat horizontal X-braced twin-truss emitter frame!
      return (
        <>
          <rect x="4" y="7" width="16" height="10" rx="1.8" {...s} />
          <line x1="5.5" y1="8.2" x2="18.5" y2="15.8" {...s} />
          <line x1="18.5" y1="8.2" x2="5.5" y2="15.8" {...s} />
          <line x1="4.5" y1="12" x2="19.5" y2="12" {...dim} />
        </>
      );
    }
    if (id.startsWith('BPO_Armour_01') || id.startsWith('BPO_ArmourSlope_')) {
      return (
        <>
          <polygon points="4,17 20,17 16,7 7,7" {...s} />
          <line x1="12" y1="7" x2="12" y2="17" {...dim} />
        </>
      );
    }

    // Default clean architectural square
    return (
      <>
        <rect x="4.5" y="4.5" width="15" height="15" rx="2" {...s} />
        <rect x="8.5" y="8.5" width="7" height="7" rx="1" {...dim} />
      </>
    );
  };

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="cad-glyph-svg" aria-hidden="true">
      {renderShape()}
    </svg>
  );
};
