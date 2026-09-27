declare module 'pdf-parse' {
  interface PdfParseResult {
    numpages: number;
    text: string;
  }

  function pdfParse(bytes: Buffer, options?: { max?: number }): Promise<PdfParseResult>;
  export default pdfParse;
}
