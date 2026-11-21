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

    // Underground belts
    if (id.startsWith('DAT_UndergroundBelt')) {
      return (
        <>
          <polyline points="8,6 19,6 19,18 8,18" {...s} />
          <line x1="15" y1="8" x2="15" y2="16" {...dim} />
          <polyline points="5,9.5 9.5,12 5,14.5" {...s} />
        </>
      );
    }

    // Splitters
    if (id.startsWith('DAT_Splitter')) {
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" {...dim} />
          <line x1="4" y1="12" x2="19" y2="12" {...s} />
          <line x1="12" y1="5" x2="12" y2="19" {...s} />
          <polyline points="15.5,9.5 18.5,12 15.5,14.5" {...s} />
        </>
      );
    }

    // Belt Balancers
    if (id.startsWith('DAT_BeltBalancer')) {
      return (
        <>
          <rect x="5" y="3" width="14" height="18" rx="2" {...dim} />
          <line x1="5" y1="7.5" x2="19" y2="16.5" {...s} />
          <line x1="5" y1="16.5" x2="19" y2="7.5" {...s} />
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
    if (id.includes('SciLab') || id === 'DAT_RelicAnalyzer') {
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2.5" {...dim} />
          <circle cx="12" cy="12" r="5.2" {...s} />
          <line x1="6" y1="12" x2="18" y2="12" {...dim} />
          <line x1="12" y1="6" x2="12" y2="18" {...dim} />
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
      return <path d="M4,20 V8 L8,4 H20 V12 H12 V20 Z" {...s} />;
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
