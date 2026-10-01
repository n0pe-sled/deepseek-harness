/** Browser entry shares Mammoth's public API. */
declare module 'mammoth/mammoth.browser.js' {
  import mammoth from 'mammoth'
  export default mammoth
}

/** The browser bundle exposes ExcelJS's document workbook API. */
declare module 'exceljs/dist/exceljs.min.js' {
  import ExcelJS from 'exceljs'
  export default ExcelJS
}
