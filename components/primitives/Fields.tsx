import React from "react";

interface SelectFieldProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  children: React.ReactNode;
}

export function SelectField({ children, className, ...rest }: SelectFieldProps) {
  return (
    <select
      className={["select-field", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </select>
  );
}

interface TextFieldProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

export function TextField({ className, ...rest }: TextFieldProps) {
  return (
    <input
      className={["text-field", className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

interface RangeSliderProps extends React.InputHTMLAttributes<HTMLInputElement> {
  flex?: boolean;
}

export function RangeSlider({ flex, className, ...rest }: RangeSliderProps) {
  return (
    <input
      type="range"
      className={[
        flex ? "range-slider--flex" : "range-slider",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}
