import React, { useEffect } from "react";
import { cn } from "@/lib/utils";

const STYLE_ID = "bubble-rise-button-styles";

const CSS = `
.bubble-rise-btn{
  width: 100%;
  padding: 12px 8px;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: none;
  color: #065f46;
  background: rgba(255,255,255,0.55);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 2px solid rgba(16,185,129,0.85);
  border-radius: 14px;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: color 0.4s ease, background 0.3s ease, box-shadow 0.3s ease, transform 0.15s ease;
  z-index: 1;
  box-shadow:
    0 10px 18px rgba(0,0,0,0.10),
    inset 0 1px 0 rgba(255,255,255,0.55);
}

.bubble-rise-btn:disabled{
  cursor:not-allowed;
  opacity: 0.65;
}

.bubble-rise-btn .liquid{
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 0%;
  background: linear-gradient(180deg, #6ee7b7 0%, #34d399 50%, #10b981 100%);
  transition: height 0.6s cubic-bezier(0.4, 0, 0.2, 1);
  z-index: -1;
}

.bubble-rise-btn.on{ color: #fff; border-color: rgba(16,185,129,0.95); }
.bubble-rise-btn.on .liquid{ height: 100%; }

.bubble-rise-btn .bubble{
  position: absolute;
  bottom: -10px;
  background: rgba(255,255,255,0.42);
  border-radius: 50%;
  z-index: 0;
  opacity: 0;
}

.bubble-rise-btn.on .bubble{
  animation: bubble-rise-up 1.5s ease-in-out infinite;
}

.bubble-rise-btn .b1{ width: 8px; height: 8px; left: 18%; animation-delay: 0s; }
.bubble-rise-btn .b2{ width: 6px; height: 6px; left: 46%; animation-delay: 0.3s; }
.bubble-rise-btn .b3{ width: 10px; height: 10px; left: 72%; animation-delay: 0.6s; }
.bubble-rise-btn .b4{ width: 5px; height: 5px; left: 34%; animation-delay: 0.9s; }

@keyframes bubble-rise-up{
  0%{ bottom: -10px; opacity: 0; }
  20%{ opacity: 1; }
  100%{ bottom: 115%; opacity: 0; }
}

.bubble-rise-btn:hover{
  box-shadow:
    0 0 22px rgba(52,211,153,0.30),
    0 10px 18px rgba(0,0,0,0.12),
    inset 0 1px 0 rgba(255,255,255,0.60);
  background: rgba(255,255,255,0.68);
}

.bubble-rise-btn:active{
  transform: translateY(1px);
}

.bubble-rise-btn .label{
  position: relative;
  z-index: 2;
  line-height: 1;
  white-space: nowrap;
}
`;

function ensureStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

export default function BubbleRiseButton({
  active = false,
  className,
  disabled,
  onClick,
  type = "button",
  label,
  children,
  ...props
}) {
  useEffect(() => {
    ensureStyle();
  }, []);

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={cn("bubble-rise-btn", active ? "on" : "", className)}
      {...props}
    >
      <div className="liquid" />
      <div className="bubble b1" />
      <div className="bubble b2" />
      <div className="bubble b3" />
      <div className="bubble b4" />
      <span className="label">{label ?? children}</span>
    </button>
  );
}
