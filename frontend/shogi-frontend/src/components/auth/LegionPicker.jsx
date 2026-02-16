import React, { useMemo, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { getLegions, normalizeLegionCode } from '@/utils/legion';
import LegionFlagIcon from '@/components/common/LegionFlagIcon';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';

export default function LegionPicker({ id, value, onChange, disabled = false, className = '' }) {
  const options = useMemo(() => getLegions(), []);
  const current = normalizeLegionCode(value, options[0]?.code || 'JP');
  const currentLabel = options.find((x) => x.code === current)?.label || current;
  const [open, setOpen] = useState(false);

  const choose = (code) => {
    const c = normalizeLegionCode(code, current);
    try { onChange && onChange(c); } catch {}
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          className={
            'w-full shogi-input h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ' +
            'flex items-center justify-between gap-2 ' +
            (disabled ? 'opacity-50 cursor-not-allowed ' : '') +
            (className || '')
          }
        >
          <span className="flex items-center gap-2 min-w-0">
            <LegionFlagIcon code={current} size={18} className="flex-shrink-0" />
            <span className="truncate">{currentLabel}</span>
          </span>
          <ChevronDown className="w-4 h-4 opacity-60 flex-shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="p-1 w-[--radix-popover-trigger-width] max-w-[calc(100vw-2rem)] shogi-popover-paper"
      >
        <div className="max-h-64 overflow-auto">
          {options.map((x) => {
            const active = x.code === current;
            return (
              <button
                key={x.code}
                type="button"
                onClick={() => choose(x.code)}
                className={
                  'w-full flex items-center gap-2 px-2 py-2 rounded-md text-left hover:bg-black/5 ' +
                  (active ? 'bg-black/5 ' : '')
                }
              >
                <LegionFlagIcon code={x.code} size={18} className="flex-shrink-0" />
                <span className="flex-1 min-w-0 text-sm truncate">{x.label}</span>
                {active ? <Check className="w-4 h-4 opacity-70" /> : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
