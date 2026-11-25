export const MAX_BYTES = 25 * 1024 * 1024;
export const safeName = (n: string) => n.normalize('NFKD').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(-120) || 'file';
