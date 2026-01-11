declare module 'sql.js' {
  export interface SqlDatabase {
    export(): Uint8Array
    run(sql: string, params?: any[]): any
    exec(sql: string): any[]
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
