"use client";

import { BaseEdge, EdgeProps, getBezierPath } from "reactflow";

function sanitizeSvgId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function FlowingEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  style
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.3
  });

  const safeId = sanitizeSvgId(id);
  const motionPathId = `rf-flow-path-${safeId}`;
  const glowFilterId = `rf-flow-glow-${safeId}`;
  const baseStroke = selected ? "rgba(186, 219, 255, 0.6)" : "rgba(176, 191, 221, 0.42)";
  const glowStroke = selected ? "rgba(143, 221, 255, 0.95)" : "rgba(122, 196, 255, 0.9)";
  const baseStrokeWidth = Number(style?.strokeWidth ?? 1.45);

  return (
    <g className="react-flow__edge-flowing">
      <defs>
        <path id={motionPathId} d={edgePath} />
        <filter id={glowFilterId} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.1" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: baseStroke,
          strokeWidth: baseStrokeWidth,
          strokeLinecap: "round"
        }}
      />

      <path
        d={edgePath}
        fill="none"
        stroke={glowStroke}
        strokeWidth={Math.max(1.2, baseStrokeWidth - 0.05)}
        strokeLinecap="round"
        filter={`url(#${glowFilterId})`}
        strokeDasharray="14 20"
        className="rf-flow-edge-glow"
        style={{ pointerEvents: "none" }}
      />

      <circle r="2.6" fill={glowStroke} filter={`url(#${glowFilterId})`} style={{ pointerEvents: "none" }}>
        <animateMotion dur="1.5s" repeatCount="indefinite" rotate="auto">
          {/* eslint-disable-next-line react/no-unknown-property */}
          <mpath href={`#${motionPathId}`} xlinkHref={`#${motionPathId}`} />
        </animateMotion>
      </circle>
    </g>
  );
}

