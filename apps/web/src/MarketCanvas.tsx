import { useEffect, useRef } from "react";

type MarketCanvasProps = {
  phase?: "bidding" | "proof" | "settlement";
  className?: string;
};

type Point = { x: number; y: number };

const COLORS = {
  grid: "rgba(18, 30, 25, 0.08)",
  line: "rgba(18, 30, 25, 0.24)",
  ink: "#16231d",
  mint: "#a9f2cf",
  green: "#137a54",
  coral: "#e36b58",
  paper: "#f5f7f4",
};

function line(context: CanvasRenderingContext2D, from: Point, to: Point, color: string, width = 1) {
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.strokeStyle = color;
  context.lineWidth = width;
  context.stroke();
}

function dot(context: CanvasRenderingContext2D, point: Point, radius: number, fill: string, stroke?: string) {
  context.beginPath();
  context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.fillStyle = fill;
  context.fill();
  if (stroke) {
    context.strokeStyle = stroke;
    context.lineWidth = 1;
    context.stroke();
  }
}

export function MarketCanvas({ phase = "bidding", className = "" }: MarketCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let width = 0;
    let height = 0;
    let frame = 0;
    let animation = 0;
    let pointer: Point | null = null;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const drawGrid = () => {
      const size = width < 700 ? 34 : 48;
      context.strokeStyle = COLORS.grid;
      context.lineWidth = 1;
      for (let x = width % size; x < width; x += size) line(context, { x, y: 0 }, { x, y: height }, COLORS.grid);
      for (let y = height % size; y < height; y += size) line(context, { x: 0, y }, { x: width, y }, COLORS.grid);
    };

    const render = (time: number) => {
      context.clearRect(0, 0, width, height);
      drawGrid();

      const compact = width < 760;
      const center: Point = compact
        ? { x: width * 0.72, y: height * 0.56 }
        : { x: width * 0.79, y: height * 0.5 };
      const spread = Math.min(height * 0.23, 142);
      const sources: Point[] = compact
        ? [
            { x: width * 0.22, y: center.y - spread },
            { x: width * 0.18, y: center.y },
            { x: width * 0.24, y: center.y + spread },
          ]
        : [
            { x: width * 0.57, y: center.y - spread },
            { x: width * 0.53, y: center.y },
            { x: width * 0.59, y: center.y + spread },
          ];
      const destination: Point = compact
        ? { x: width * 0.72, y: height * 0.18 }
        : { x: width * 0.92, y: center.y };

      sources.forEach((source, index) => {
        line(context, source, center, COLORS.line);
        dot(context, source, 17, COLORS.paper, COLORS.line);
        dot(context, source, 5, index === 1 ? COLORS.coral : COLORS.green);

        if (phase === "bidding") {
          const speed = reducedMotion ? 0.45 : ((time / 2600 + index * 0.28) % 1);
          const eased = speed * speed * (3 - 2 * speed);
          const packet = {
            x: source.x + (center.x - source.x) * eased,
            y: source.y + (center.y - source.y) * eased,
          };
          dot(context, packet, 4.5, COLORS.mint, COLORS.green);
        }
      });

      context.save();
      context.translate(center.x, center.y);
      context.rotate(reducedMotion ? 0 : time / 19000);
      context.strokeStyle = phase === "proof" ? COLORS.green : COLORS.ink;
      context.lineWidth = 1.5;
      context.strokeRect(-30, -30, 60, 60);
      context.strokeRect(-21, -21, 42, 42);
      context.restore();
      dot(context, center, 8, phase === "proof" ? COLORS.mint : COLORS.ink);

      if (phase !== "bidding") {
        line(context, center, destination, phase === "settlement" ? COLORS.green : COLORS.line, phase === "settlement" ? 2 : 1);
        const progress = reducedMotion ? 1 : ((time / 1800) % 1);
        const settlementPacket = {
          x: center.x + (destination.x - center.x) * progress,
          y: center.y + (destination.y - center.y) * progress,
        };
        dot(context, settlementPacket, 5, phase === "settlement" ? COLORS.coral : COLORS.mint, COLORS.green);
        dot(context, destination, 19, COLORS.paper, COLORS.line);
        context.fillStyle = COLORS.ink;
        context.fillRect(destination.x - 8, destination.y - 8, 16, 16);
      }

      if (pointer) {
        const nearby = Math.hypot(pointer.x - center.x, pointer.y - center.y) < 120;
        if (nearby) {
          context.beginPath();
          context.arc(center.x, center.y, 43, 0, Math.PI * 2);
          context.strokeStyle = "rgba(19, 122, 84, 0.3)";
          context.lineWidth = 1;
          context.stroke();
        }
      }

      frame = window.requestAnimationFrame(render);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    const onPointerMove = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    const onPointerLeave = () => { pointer = null; };
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
    resize();
    animation = window.requestAnimationFrame(render);

    return () => {
      resizeObserver.disconnect();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      window.cancelAnimationFrame(animation);
      window.cancelAnimationFrame(frame);
    };
  }, [phase]);

  return <canvas ref={canvasRef} className={`market-canvas ${className}`} aria-hidden="true" />;
}
