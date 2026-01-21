declare module 'sql.js' {
  export interface SqlDatabase {
    export(): Uint8Array
    run(sql: string, params?: unknown[]): unknown
    exec(sql: string): unknown[]
    close(): void
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => SqlDatabase
  }

  interface SqlJsConstructor {
    (): Promise<SqlJsStatic>
  }

  const initSqlJs: SqlJsConstructor
  export default initSqlJs
}
