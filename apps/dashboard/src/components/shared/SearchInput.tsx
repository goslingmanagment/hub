import { useState, useEffect } from "react";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SearchInput({ value, onChange, placeholder = "Search…" }: SearchInputProps) {
  const [local, setLocal] = useState(value);

  // Sync external value changes
  useEffect(() => {
    setLocal(value);
  }, [value]);

  // Debounce local -> parent
  useEffect(() => {
    const timer = setTimeout(() => {
      if (local !== value) {
        onChange(local);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [local, onChange, value]);

  return (
    <input
      type="search"
      aria-label={placeholder}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      placeholder={placeholder}
      className="w-full sm:w-[220px] min-w-0 rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-accent"
    />
  );
}
