import React from 'react'
export const Badge = ({ children, className='' }) => (
  <span className={`inline-block px-2 py-0.5 text-xs rounded bg-gray-200 ${className}`}>{children}</span>
)
export default Badge
