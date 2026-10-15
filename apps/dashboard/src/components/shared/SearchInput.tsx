import { useState, useEffect } from "react";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SearchInput({ value, onChange, placeholder = "Поиск…" }: SearchInputProps) {
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
      type="text"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      className="input w-full placeholder:text-text-muted sm:w-[240px]"
    />
  );
}
