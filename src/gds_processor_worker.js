import { WORKER_MSG_TYPE } from './defines.js';
import gdsProcessorInit from './gds_processor.js';

let ModuleInstance;

async function initialize() {
  ModuleInstance = await gdsProcessorInit(); // Emscripten initializes the WASM
  self.postMessage({ type: WORKER_MSG_TYPE.WORKER_READY });
  // console.log("wasm module initialized");

  // Handle messages from the main thread
  self.onmessage = (event) => {
    if (event.data.type == WORKER_MSG_TYPE.PROCESS_GDS) {
      ModuleInstance.FS.mkdir('/uploaded');

      ModuleInstance.FS.writeFile(event.data.filename, event.data.data);
      ModuleInstance.ccall(
        'processGDS',
        null,
        ['string', 'number'],
        [event.data.filename, event.data.opt_just_lines ? 1 : 0],
      );
    } else if (event.data.type == WORKER_MSG_TYPE.PROCESS_CELLS) {
      ModuleInstance.ccall('processCells', null, ['number'], [event.data.opt_just_lines ? 1 : 0]);
      self.postMessage({ type: WORKER_MSG_TYPE.PROCESS_ENDED });
    } else if (event.data.type == WORKER_MSG_TYPE.ADD_PROCESS_LAYER) {
      ModuleInstance.ccall(
        'addProcessLayer',
        null,
        ['number', 'number', 'string', 'number', 'number'],
        [
          event.data.layer_number,
          event.data.layer_datatype,
          event.data.name,
          event.data.zmin,
          event.data.zmax,
        ],
      );
    }
  };

  self.gds_add_cell = (cell_name, bounds, is_top_cell) => {
    self.postMessage({
      type: WORKER_MSG_TYPE.ADD_CELL,
      cell_name: cell_name,
      bounds: bounds,
      is_top_cell: is_top_cell,
    });
  };

  self.gds_add_lines = (
    cell_name,
    mesh_name,
    layer_number,
    layer_datatype,
    positions_count,
    positions_ptr,
    indices_count,
    indices_ptr,
  ) => {
    const positionsArray = new Float32Array(
      ModuleInstance.HEAPF32.buffer,
      positions_ptr,
      positions_count,
    );
    const indicesArray = new Uint32Array(ModuleInstance.HEAP32.buffer, indices_ptr, indices_count);

    const lines_buffer = new ArrayBuffer(
      positions_count * Float32Array.BYTES_PER_ELEMENT +
        indices_count * Uint32Array.BYTES_PER_ELEMENT,
    );
    const positionsView = new Float32Array(lines_buffer, 0, positions_count);
    const indicesView = new Uint32Array(
      lines_buffer,
      positions_count * Float32Array.BYTES_PER_ELEMENT,
      indices_count,
    );

    positionsView.set(new Float32Array(positionsArray));
    indicesView.set(new Uint32Array(indicesArray));

    self.postMessage(
      {
        type: WORKER_MSG_TYPE.ADD_LINES,
        cell_name: cell_name,
        mesh_name: mesh_name,
        layer_number: layer_number,
        layer_datatype: layer_datatype,
        positions_offset: 0,
        positions_count: positions_count,
        indices_offset: positions_count,
        indices_count: indices_count,
        buffer: lines_buffer,
      },
      [lines_buffer],
    );
  };

  self.gds_add_mesh = (
    cell_name,
    mesh_name,
    layer_number,
    layer_datatype,
    positions_count,
    positions_ptr,
    indices_count,
    indices_ptr,
  ) => {
    const positionsArray = new Float32Array(
      ModuleInstance.HEAPF32.buffer,
      positions_ptr,
      positions_count,
    );
    const indicesArray = new Uint32Array(ModuleInstance.HEAP32.buffer, indices_ptr, indices_count);

    const mesh_buffer = new ArrayBuffer(
      positions_count * Float32Array.BYTES_PER_ELEMENT +
        indices_count * Uint32Array.BYTES_PER_ELEMENT,
    );
    const positionsView = new Float32Array(mesh_buffer, 0, positions_count);
    const indicesView = new Uint32Array(
      mesh_buffer,
      positions_count * Float32Array.BYTES_PER_ELEMENT,
      indices_count,
    );

    positionsView.set(new Float32Array(positionsArray));
    indicesView.set(new Uint32Array(indicesArray));

    self.postMessage(
      {
        type: WORKER_MSG_TYPE.ADD_MESH,
        cell_name: cell_name,
        mesh_name: mesh_name,
        layer_number: layer_number,
        layer_datatype: layer_datatype,
        positions_offset: 0,
        positions_count: positions_count,
        indices_offset: positions_count,
        indices_count: indices_count,
        buffer: mesh_buffer,
      },
      [mesh_buffer],
    );
  };

  self.gds_add_label = (
    cell_name,
    layer_number,
    layer_datatype,
    text,
    origin_x,
    origin_y,
    pos_z,
  ) => {
    self.postMessage({
      type: WORKER_MSG_TYPE.ADD_LABEL,
      cell_name: cell_name,
      layer_number: layer_number,
      layer_datatype: layer_datatype,
      text: text,
      origin_x: origin_x,
      origin_y: origin_y,
      pos_z: pos_z,
    });
  };

  self.gds_add_reference = (
    parent_cell_name,
    cell_name,
    instance_name,
    origin_x,
    origin_y,
    rotation,
    x_reflection,
  ) => {
    self.postMessage({
      type: WORKER_MSG_TYPE.ADD_REFERENCE,
      parent_cell_name: parent_cell_name,
      cell_name: cell_name,
      instance_name: instance_name,
      origin_x: origin_x,
      origin_y: origin_y,
      rotation: rotation,
      x_reflection: x_reflection,
    });
  };

  self.gds_finished_references = () => {
    self.postMessage({
      type: WORKER_MSG_TYPE.FINISHED_REFERENCES,
    });
  };

  self.gds_info_log = (msg, timestamp) => {
    // const logsPreTag = document.querySelector("#logs > pre"); //document.getElementById('logs');
    // logsPreTag.textContent += msg;
    self.postMessage({ type: WORKER_MSG_TYPE.LOG, text: msg, timestamp: timestamp });
    // console.log(msg);
  };

  self.gds_process_progress = (progress) => {
    self.postMessage({ type: WORKER_MSG_TYPE.PROCESS_PROGRESS, progress: progress });
  };

  self.gds_stats = (design_name, stats) => {
    self.postMessage({ type: WORKER_MSG_TYPE.STATS, design_name: design_name, stats: stats });
  };
}

initialize();

// ModuleInstance = gdsProcessorInit;
// ModuleInstance = Module;

// Module().then((ModuleInstance) => {
//     console.log('WebAssembly module loaded');

// ModuleInstance['onRuntimeInitialized'] = function() {
//     self.postMessage({ type: WORKER_MSG_TYPE.WORKER_READY });
//     // console.log("wasm loaded ");
//  }

// });
