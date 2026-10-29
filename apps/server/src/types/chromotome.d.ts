declare module 'chromotome' {
  export interface ChromotomePalette {
    name: string;
    colors: string[];
    stroke?: string;
    background?: string;
    size: number;
  }
  export function getAll(): ChromotomePalette[];
  export function get(name?: string): ChromotomePalette;
  export function getNames(): string[];
}
