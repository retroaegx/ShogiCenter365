import React from 'react'
// src/components/ui/alert.jsx
export function Alert({ className, ...props }) {
  return <div role="alert" className={`relative w-full rounded-lg border p-4 ${className||''}`} {...props} />;
}
export function AlertTitle({ className, ...props }) {
  return <h5 className={`mb-1 font-medium leading-none tracking-tight ${className||''}`} {...props} />;
}
export function AlertDescription({ className, ...props }) {
  return <p className={`text-sm [&_p]:leading-relaxed ${className||''}`} {...props} />;
}

export default Alert
