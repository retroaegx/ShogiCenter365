import React from "react";
import { t } from "@/i18n";
import { Clock } from "lucide-react";

export default function TimerPill({ isBottom, isTurn, ms, fmt }) {
  const base = isBottom ? "from-emerald-600 to-emerald-500" : "from-slate-700 to-slate-600";
  const turnFx = isTurn ? "ring-2 ring-amber-400 animate-pulse" : "";
  return (
    <div
      className={`flex items-center gap-1 px-2 py-0.5 rounded-full shadow-sm font-mono tabular-nums
                  bg-gradient-to-r ${base} ${turnFx}`}
      title={isTurn ? t("ui.components.game.timerpill.k84dfcd7e") : t("ui.components.game.timerpill.k1df5bf85")}
      style={{ color: "#fff" }}
    >
      <Clock className="h-4 w-4 opacity-90" />
      <span className="text-sm leading-5">{fmt(ms)}</span>
    </div>
  );
}
