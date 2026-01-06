import React, { useEffect, useId, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

const STYLE_ID = "glass-draw-action-button-styles";

const CSS = `
.glass-draw-btn{
  position:relative;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:8px;
  padding: 12px 18px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: none;
  color: rgba(15,23,42,0.92);
  background: linear-gradient(135deg, rgba(255,255,255,0.78) 0%, rgba(255,255,255,0.45) 55%, rgba(255,255,255,0.25) 100%);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border: 1px solid rgba(255,255,255,0.55);
  border-radius: 16px;
  cursor: pointer;
  overflow: hidden;
  transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
  z-index: 1;
  box-shadow:
    0 10px 22px rgba(0,0,0,0.14),
    inset 0 1px 0 rgba(255,255,255,0.55);
}

.glass-draw-btn:disabled{
  cursor:not-allowed;
  opacity: 0.65;
}

.glass-draw-btn::before{
  content:'';
  position:absolute;
  inset:0;
  background: linear-gradient(135deg, rgba(255,255,255,0.55) 0%, transparent 60%);
  opacity:0;
  transition: opacity 0.35s ease;
}

.glass-draw-btn.hovered::before{ opacity: 1; }

.glass-draw-btn::after{
  content:'';
  position:absolute;
  top:0;
  left:-100%;
  width:60%;
  height:100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent);
  transform: skewX(-20deg);
}

.glass-draw-btn.hovered::after{ animation: glass-shimmer 1.4s ease forwards; }

@keyframes glass-shimmer{
  0%{ left:-100%; }
  100%{ left:150%; }
}

.glass-draw-btn.hovered{
  transform: translateY(-3px);
  box-shadow:
    0 18px 36px rgba(0,0,0,0.22),
    0 0 54px rgba(0, 255, 255, 0.14),
    inset 0 1px 0 rgba(255,255,255,0.22);
}

.glass-draw-btn.clicked{
  transform: translateY(-1px) scale(0.985);
  transition: all 0.1s ease;
}

.border-svg{
  position:absolute;
  inset:0;
  width:100%;
  height:100%;
  pointer-events:none;
  z-index:2;
}

.border-svg rect{
  fill:none;
  stroke-width:2;
  stroke-dasharray:500;
  stroke-dashoffset:500;
  transition: stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1);
  opacity: 0.9;
}

.glass-draw-btn.hovered .border-svg rect{ stroke-dashoffset:0; }

.inner-glow{
  position:absolute;
  inset:0;
  border-radius:16px;
  background: radial-gradient(ellipse at center, rgba(0, 255, 255, 0.20) 0%, transparent 70%);
  opacity:0;
  transition: opacity 0.5s ease;
  pointer-events:none;
}

.glass-draw-btn.hovered .inner-glow{ opacity:1; }

.click-ripple{
  position:absolute;
  border-radius:50%;
  background: radial-gradient(circle, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.25) 40%, transparent 70%);
  transform: scale(0);
  animation: glass-ripple-expand 0.8s cubic-bezier(0.4, 0, 0.2, 1) forwards;
  pointer-events:none;
}

@keyframes glass-ripple-expand{
  0%{ transform: scale(0); opacity:1; }
  100%{ transform: scale(4); opacity:0; }
}

.pulse-ring{
  position:absolute;
  inset:-4px;
  border-radius:20px;
  border:2px solid rgba(0, 255, 255, 0.55);
  opacity:0;
  pointer-events:none;
}

.glass-draw-btn.clicked .pulse-ring{ animation: glass-pulse-out 0.6s ease-out forwards; }

@keyframes glass-pulse-out{
  0%{ transform: scale(1); opacity:1; }
  100%{ transform: scale(1.15); opacity:0; }
}

.btn-text{
  position:relative;
  z-index:3;
  transition: all 0.3s ease;
  text-shadow: 0 1px 0 rgba(255,255,255,0.35);
}

.glass-draw-btn.clicked .btn-text{ text-shadow: 0 0 18px rgba(255,255,255,0.75); }

/* Variants (DISCOVER / CREATE) */
.glass-draw-btn.cyan{
  background: linear-gradient(135deg, rgba(0,255,255,0.26) 0%, rgba(255,255,255,0.44) 55%, rgba(0,255,255,0.12) 100%);
}
.glass-draw-btn.cyan.hovered{
  box-shadow:
    0 18px 36px rgba(0,0,0,0.22),
    0 0 54px rgba(0, 255, 255, 0.22),
    inset 0 1px 0 rgba(255,255,255,0.22);
}
.glass-draw-btn.cyan .inner-glow{
  background: radial-gradient(ellipse at center, rgba(0, 255, 255, 0.22) 0%, transparent 70%);
}
.glass-draw-btn.cyan .pulse-ring{ border-color: rgba(0, 255, 255, 0.60); }

.glass-draw-btn.rose{
  background: linear-gradient(135deg, rgba(255,100,150,0.24) 0%, rgba(255,255,255,0.42) 55%, rgba(255,100,150,0.12) 100%);
}
.glass-draw-btn.rose.hovered{
  box-shadow:
    0 18px 36px rgba(0,0,0,0.22),
    0 0 54px rgba(255, 100, 150, 0.24),
    inset 0 1px 0 rgba(255,255,255,0.22);
}
.glass-draw-btn.rose .inner-glow{
  background: radial-gradient(ellipse at center, rgba(255, 100, 150, 0.22) 0%, transparent 70%);
}
.glass-draw-btn.rose .pulse-ring{ border-color: rgba(255, 100, 150, 0.60); }
`;

function ensureStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/**
 * GlassDrawButton の DISCOVER(Cyan) / CREATE(Rose) を、通常のボタンとして使える形にしたもの。
 * - デザインはそのまま
 * - onClick は外から渡せる
 */
export default function GlassDrawActionButton({
  variant = "discover", // 'discover' | 'create'
  className,
  disabled,
  onClick,
  type = "button",
  children,
  ...props
}) {
  useEffect(() => {
    ensureStyle();
  }, []);

  const [isClicked, setIsClicked] = useState(false);
  const [ripples, setRipples] = useState([]);
  const [isHovered, setIsHovered] = useState(false);

  const uid = useId().replace(/:/g, "");
  const gradientId = useMemo(() => {
    const key = variant === "create" ? "rose" : "cyan";
    return `glass-draw-${key}-${uid}`;
  }, [variant, uid]);

  const vClass = variant === "create" ? "rose" : "cyan";

  const handleClick = (e) => {
    if (disabled) return;

    try {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const id = Date.now();

      setRipples((prev) => [...prev, { x, y, id }]);
      setIsClicked(true);

      window.setTimeout(() => setRipples((prev) => prev.filter((r) => r.id !== id)), 800);
      window.setTimeout(() => setIsClicked(false), 300);
    } catch {
      // ignore
    }

    onClick?.(e);
  };

  return (
    <button
      type={type}
      disabled={disabled}
      className={cn(
        "glass-draw-btn",
        vClass,
        isHovered ? "hovered" : "",
        isClicked ? "clicked" : "",
        className
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleClick}
      {...props}
    >
      {/* per-instance gradient */}
      <svg style={{ position: "absolute", width: 0, height: 0 }} aria-hidden="true">
        <defs>
          {variant === "create" ? (
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#ff6496" />
              <stop offset="50%" stopColor="#ff96b4" />
              <stop offset="100%" stopColor="#ff6496" />
            </linearGradient>
          ) : (
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#0ff" />
              <stop offset="50%" stopColor="#0af" />
              <stop offset="100%" stopColor="#0ff" />
            </linearGradient>
          )}
        </defs>
      </svg>

      <div className="inner-glow" />
      <div className="pulse-ring" />

      <svg className="border-svg" aria-hidden="true">
        <rect
          x="1"
          y="1"
          width="calc(100% - 2px)"
          height="calc(100% - 2px)"
          rx="15"
          style={{ stroke: `url(#${gradientId})` }}
        />
      </svg>

      {ripples.map((r) => (
        <span
          key={r.id}
          className="click-ripple"
          style={{ left: r.x - 25, top: r.y - 25, width: 50, height: 50 }}
        />
      ))}

      <span className="btn-text">{children}</span>
    </button>
  );
}
