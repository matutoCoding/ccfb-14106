/** Vite ?raw 导入与 Worker 模块声明 */
declare module '*.wgsl?raw' {
  const content: string;
  export default content;
}

declare module '*?worker' {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}
