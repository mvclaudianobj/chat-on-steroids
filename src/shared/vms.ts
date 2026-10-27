export type VmAction = 'status' | 'up' | 'halt' | 'provision' | 'destroy';
export interface VmLab { name: string; box?: string; memory?: number; cpus?: number; valid: boolean; }
export interface VmDoctor { ready: boolean; checks: { id: 'vagrant' | 'virtualbox' | 'ansible'; available: boolean; reason?: string }[]; }
export interface VmJob { name: string; action: VmAction; running: boolean; log: string[]; exitCode?: number; }
export interface VmView { labs: VmLab[]; doctor: VmDoctor; jobs: VmJob[]; }
