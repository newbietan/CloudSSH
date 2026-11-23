declare module '*.rdp-bin' {
  const bytes: ArrayBuffer;
  export default bytes;
}

declare module '*.rdp-text' {
  const text: string;
  export default text;
}
