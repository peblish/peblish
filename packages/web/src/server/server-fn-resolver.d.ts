// TanStack Start's virtual module (start-server-core's package imports), resolved by its Vite
// plugin: the build's registry of server functions by id. Only the one export the server entry uses.
declare module '#tanstack-start-server-fn-resolver' {
  export function getServerFnById(id: string, access: { origin: 'client' | 'server' }): Promise<unknown>;
}
