export { WORKER_MSG_TYPE };

const WORKER_MSG_TYPE = {
    WORKER_READY: 'worker_ready',
    LOG: 'log',
    STATS: 'stats',
    ADD_CELL: 'add_cell',
    ADD_MESH: 'add_mesh',
    ADD_REFERENCE: 'add_reference',
    ADD_LABEL: 'add_label',
    
    FINISHED_REFERENCES: 'finished_references',
    
    PROCESS_ENDED: 'process_ended' ,

    PROCESS_PROGRESS: 'process_progress',

    ADD_PROCESS_LAYER: 'add_process_layer',
    PROCESS_GDS: 'process_gds',
    PROCESS_CELLS: 'process_cells',

    ADD_LINES: 'add_lines'
};


if (typeof self !== 'undefined' && typeof self.importScripts === 'function') {
    // Classic Worker (importScripts) environment
    self.WORKER_MSG_TYPE = WORKER_MSG_TYPE;
} 