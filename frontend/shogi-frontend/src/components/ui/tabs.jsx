import React, { useState, createContext, useContext } from 'react'
const TabsCtx = createContext(null)
export const Tabs = ({ defaultValue, children, className='' }) => {
  const [value, setValue] = useState(defaultValue)
  return <TabsCtx.Provider value={{ value, setValue }}><div className={className}>{children}</div></TabsCtx.Provider>
}
export const TabsList = ({ children, className='' }) => (<div className={`flex gap-2 mb-2 ${className}`}>{children}</div>)
export const TabsTrigger = ({ value, children }) => {
  const { value: v, setValue } = useContext(TabsCtx)
  const active = v === value
  return <button onClick={() => setValue(value)} className={`px-3 py-1 rounded ${active ? 'border-b-2' : 'opacity-70'}`}>{children}</button>
}
export const TabsContent = ({ value, children }) => {
  const { value: v } = useContext(TabsCtx)
  return v === value ? <div>{children}</div> : null
}
export default Tabs
