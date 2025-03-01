import * as THREE from 'three';
import * as OrbitControls from 'three/examples/jsm/controls/OrbitControls';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { GDS } from './GDS_data.js';
import { WORKER_MSG_TYPE } from './defines.js';

// We can't load HTTP resources anyway, so let's just assume HTTPS
function toHttps(url) {
  if (typeof url != 'string') {
    return url;
  }
  if (['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)) {
    return url;
  }
  return url.replace(/^http:\/\//i, 'https://');
}

const urlParams = new URLSearchParams(location.search);
const GDS_URL = toHttps(urlParams.get('model')) || 'tinytapeout.gds';

const gdsProcessorWorker = new Worker(new URL("./gds_processor_worker.js", import.meta.url), { type: "module" });
// const gdsProcessorWorker = new Worker("gds_processor_worker.js");

let parser;

// THREE.js scene objects
let scene, scene_root_group, camera, renderer, cameraControls;
let raycaster;

// THREE.js scene objects for section view
let section_renderer,
  section_camera,
  section_renderer_box,
  section_renderer_box_helper,
  section_view_size;

// Hierarchical structure
// let node_graph;

let selected_object;
let selection_helper;
let isolation_history = [];
let highlighted_objects = [];
let highlighted_prev_colors = [];
let highlight_color = new THREE.Color(-1, 2, -1, -1);
let mouse, mouse_moved, mouse_down_time;



let animation_last_time = 0;

// Experimental features options:
let experimental_show_section_on = false;

let experimental_bw_mode_prev_state = [];
let experimental_bw_mode_on = false;

let experimental_auto_rotation = false;
let experimental_auto_rotation_speed = 0.01;

let experimental_separate_layers_level = 0;
let experimental_separate_layers_target = 0;

// GUI dom elements
let instanceClassTitleDiv = document.querySelector('div#instanceClassTitle');
let informationDiv = document.querySelector('div#information');
let loadingStatus = document.querySelector('div#loadingStatus');
let crossSectionDiv = document.querySelector('div#crossSection');

// lil-gui controls
let guiLayersFolder,
  guiInstancesFolder,
  guiInstancesNamesFolder,
  guiIsolateSelectionButton,
  guiZoomSelectionButton;

let viewSettings, performanceSettings, experimentalSettings;

// Debug FPS stats
let show_fps_stats = false;
let fps_stats = new Stats();
document.body.appendChild(fps_stats.dom);
fps_stats.domElement.hidden = true;

// Install vite's Hot Module Replacement (HMR) hook that listens for changes to the GLTF file
// NOTE: this only works in vite's development server mode
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    // clearGLTFScene();
  });
  import.meta.hot.on('my-gltf-change', () => {
    console.log('GLTF file changed, reloading model...');
    clearSelection();
    let reset_camera = false;
    loadGDS(GDS_URL, reset_camera); // Re-load the model without reseting the camera
  });
}

// init();


gdsProcessorWorker.addEventListener("error", function (event) {
  console.log("Error on worker thread", event);
});
gdsProcessorWorker.addEventListener("messageerror", (event) => {
  console.error(`Error receiving message from worker: ${event}`);
});
gdsProcessorWorker.addEventListener("message", function (event) {
  if (event.data.type == WORKER_MSG_TYPE.WORKER_READY) {
    console.log("WORKER_READY");
    init();

  } else if (event.data.type == WORKER_MSG_TYPE.LOG) {
    // console.log(`Message from gds_processor_worker ${event.data.text}`);

  } else if (event.data.type == WORKER_MSG_TYPE.ADD_CELL) {
    GDS.addCell(event.data.cell_name, event.data.bounds, event.data.is_top_cell);

  } else if (event.data.type == WORKER_MSG_TYPE.ADD_MESH) {
    // console.log("ADD_MESH", event.data);
    let vertices = new Float32Array(event.data.buffer, 0, event.data.positions_count);
    let indices = new Uint32Array(event.data.buffer, event.data.indices_offset * Float32Array.BYTES_PER_ELEMENT, event.data.indices_count);

    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

    // ToDo: Check this function. I think is supposed to be defined by us
    geometry.computeBoundingBox();

    const layer_id = GDS.makeLayerId(event.data.layer_number, event.data.layer_datatype);
    if (GDS.layers[layer_id] == undefined) {
      console.error(`ADD_MESH error: layer ${event.data.layer_number}/${event.data.layer_datatype} not found`);
    }
    const material = GDS.layers[layer_id].threejs_material;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = event.data.mesh_name;

    GDS.addMesh(event.data.cell_name, event.data.mesh_name, event.data.layer_number, event.data.layer_datatype, mesh);

  } else if (event.data.type == WORKER_MSG_TYPE.ADD_REFERENCE) {

    GDS.addReference(event.data.parent_cell_name, event.data.cell_name, event.data.instance_name, event.data.origin_x, event.data.origin_y, event.data.rotation, event.data.x_reflection);

  } else if (event.data.type == WORKER_MSG_TYPE.FINISHED_REFERENCES) {

    processCells(false);

  } else if (event.data.type == WORKER_MSG_TYPE.PROCESS_PROGRESS) {
    // console.log(event.data.progress);
    // processProgressBar.innerText = Math.round(event.data.progress) + "%";
    // processProgressBar.value = Math.round(event.data.progress);

  } else if (event.data.type == WORKER_MSG_TYPE.PROCESS_ENDED) {

    buildScene(null, true);
    // buildScene(GDS.top_cells[0], true);
    updateGuiAfterLoad();
  }

});

function init() {
  performanceSettings = {
    logarithmicDepthBuffer: false,
    antialias: true,
    'Show FPS': show_fps_stats,
  };

  experimentalSettings = {
    'Show section': experimental_show_section_on,
    'Section size': 0,
    'B&W depth colors': experimental_bw_mode_on,
    'Auto rotation': experimental_auto_rotation,
    'Rotation speed': experimental_auto_rotation_speed,
    'Separate layers': experimental_separate_layers_level,
  };

  viewSettings = {
    filler_cells: true,
    top_cell_geometry: true,
    layers: [],
    layers_visibility: [],
    instances: [],
  };

  init3D();

  setSectionViewVisibility(experimental_show_section_on);

  initGUI();

  initProcessLayers();

  loadGDS(GDS_URL);
}

function loadGDS(fileURL, reset_camera) {

  loadingStatus.innerText = `Downloading ${fileURL}`;

  fetchWithProgressArrayBuffer(fileURL)
    .then(buffer => {

      // hideStartupContent();
      // hideLoadingGDS();
      loadingStatus.innerText = "Processing file";

      const filename = fileURL.split('/').pop()
      const data = new Uint8Array(buffer); // File content as binary data

      // Warning: 'data' is detached after calling this function
      processGDS(filename, data);

      // Init THREE.js layers visibility
      for (const [layer_id, layer] of Object.entries(GDS.layers)) {
        const threejs_layer_id = getTHREEJSLayerFromGDSLayerId(layer_id);
        camera.layers.enable(threejs_layer_id);
        section_camera.layers.enable(threejs_layer_id);
        raycaster.layers.enable(threejs_layer_id);
      }




    }).catch(err => {
      loadingStatus.innerText = `Error loading file`;

      console.log("Found error:", err);
    });
}

function processGDS(filename, data) {
  gdsProcessorWorker.postMessage({ type: WORKER_MSG_TYPE.PROCESS_GDS, filename: `/uploaded/${filename}`, opt_just_lines: false, data: data }, [data.buffer]);
}

function processCells() {
  gdsProcessorWorker.postMessage({ type: WORKER_MSG_TYPE.PROCESS_CELLS, opt_just_lines: false });
}

function initProcessLayers() {

  const process_layers = [
    { layer_number: 235, layer_datatype: 4, name: "substrate", zmin: -2, zmax: 0, color: [ 0.2, 0.2, 0.2, 1.0] },
    { layer_number: 64, layer_datatype: 20, name: "nwell", zmin: -2, zmax: 0, color: [ 0.4, 0.4, 0.4, 1.0] },
    { layer_number: 65, layer_datatype: 20, name: "diff", zmin: -0.5, zmax: 0.01, color: [ 0.9, 0.9, 0.9, 1.0] },
    { layer_number: 66, layer_datatype: 20, name: "poly", zmin: 0, zmax: 0.18, color: [ 0.75, 0.35, 0.46, 1.0] },
    { layer_number: 66, layer_datatype: 44, name: "licon", zmin: 0, zmax: 0.936, color: [ 0.2, 0.2, 0.2, 1.0] },
    { layer_number: 67, layer_datatype: 20, name: "li1", zmin: 0.936, zmax: 1.136, color: [ 1.0, 0.81, 0.55, 1.0] },
    { layer_number: 67, layer_datatype: 44, name: "mcon", zmin: 1.011, zmax: 1.376, color: [ 0.2, 0.2, 0.2, 1.0] },
    { layer_number: 68, layer_datatype: 20, name: "met1", zmin: 1.376, zmax: 1.736, color: [ 0.16, 0.38, 0.83, 1.0] },
    { layer_number: 68, layer_datatype: 44, name: "via", zmin: 1.73, zmax: 2, color: [ 0.2, 0.2, 0.2, 1.0] },
    { layer_number: 69, layer_datatype: 20, name: "met2", zmin: 2, zmax: 2.36, color: [ 0.65, 0.75, 0.9, 1.0] },
    { layer_number: 69, layer_datatype: 44, name: "via2", zmin: 2.36, zmax: 2.786, color: [ 0.2, 0.2, 0.2, 1.0] },
    { layer_number: 70, layer_datatype: 20, name: "met3", zmin: 2.786, zmax: 3.631, color: [ 0.2, 0.62, 0.86, 1.0] },
    { layer_number: 70, layer_datatype: 44, name: "via3", zmin: 3.631, zmax: 4.0211, color: [ 0.2, 0.2, 0.2, 1.0] },
    // ToDo: check the correct position and heights of capm layers
    { layer_number: 89, layer_datatype: 44, name: "capm", zmin: 3.631 + 0.1, zmax: 3.631 + 0.1 + 0.2, color: [ 0.2, 0.32, 0.86, 1.0] },
    { layer_number: 71, layer_datatype: 20, name: "met4", zmin: 4.0211, zmax: 4.8661, color: [ 0.15, 0.11, 0.38, 1.0] },
    // ToDo: check the correct position and heights of capm layers
    { layer_number: 97, layer_datatype: 44, name: "cap2m", zmin: 4.0211 + 0.1, zmax: 4.0211 + 0.1 + 0.2, color: [ 0.15, 0.00, 0.38, 1.0] },
    { layer_number: 71, layer_datatype: 44, name: "via4", zmin: 4.8661, zmax: 5.371, color: [ 0.2, 0.2, 0.2, 1.0] },
    { layer_number: 72, layer_datatype: 20, name: "met5", zmin: 5.371, zmax: 6.6311, color: [ 0.4, 0.4, 0.4, 1.0] },
  ];

  for (let i = 0; i < process_layers.length; i++) {
    let layer_data = process_layers[i];


    gdsProcessorWorker.postMessage(
      {
        type: WORKER_MSG_TYPE.ADD_PROCESS_LAYER,
        layer_number: layer_data.layer_number,
        layer_datatype: layer_data.layer_datatype,
        name: layer_data.name,
        zmin: layer_data.zmin,
        zmax: layer_data.zmax
      }
    );

    let layer_visual_order = i;
    GDS.addLayer(layer_data.layer_number, layer_data.layer_datatype, layer_data.name, layer_visual_order, layer_data.color);
  }


}


async function fetchWithProgressArrayBuffer(url) {
  try {
    const response = await fetch(url);

    // Check if the response status is not OK
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status} - ${response.statusText}`);
    }

    // Get the total content length from the headers
    const contentLength = response.headers.get('content-length');
    if (!contentLength) {
      console.warn('Unable to retrieve content-length. Progress tracking will not work.');
      loadingStatus.innerText = "Error loading file";
      return response.arrayBuffer(); // Fallback to standard ArrayBuffer
    }

    const total = parseInt(contentLength, 10);
    let loaded = 0;

    // Create an array to store the chunks
    const chunks = [];
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      // Track progress
      loaded += value.length;
      const progress = ((loaded / total) * 100).toFixed(0);
      // console.log(`Progress: ${progress}%`);
      loadingStatus.innerText = `${progress}%`;

      // Store the chunk
      chunks.push(value);
    }

    // Concatenate all chunks into a single ArrayBuffer
    const fullArray = new Uint8Array(loaded);
    let position = 0;

    for (const chunk of chunks) {
      fullArray.set(chunk, position);
      position += chunk.length;
    }

    return fullArray.buffer; // Return as ArrayBuffer

  } catch (error) {
    console.error('Fetch error:', error);
    throw error; // Re-throw the error to allow the caller to handle it
  }
}

function init3D() {
  scene = new THREE.Scene();

  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();
  mouse_moved = false;

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 10000);

  resetRenderer();

  let section_renderer_width = 400;
  let section_renderer_height = 400;
  section_view_size = section_renderer_width / 80;
  section_camera = new THREE.OrthographicCamera(
    -section_view_size,
    section_view_size,
    section_view_size,
    -section_view_size,
    0,
    1,
  );
  section_camera.position.x = 0;
  section_camera.position.y = 0;
  section_camera.position.z = 0;
  section_camera.up.x = 0;
  section_camera.up.y = 0;
  section_camera.up.z = 1;
  section_camera.lookAt(50, 0, 0);

  section_renderer = new THREE.WebGLRenderer({
    antialias: performanceSettings.antialias,
    logarithmicDepthBuffer: performanceSettings.logarithmicDepthBuffer,
  });
  section_renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  section_renderer.domElement.id = 'SECTION_RENDERER';
  section_renderer.setSize(section_renderer_width, section_renderer_height);
  crossSectionDiv.appendChild(section_renderer.domElement);

  scene.background = new THREE.Color(0x202020);

  // const ambient_light = new THREE.AmbientLight(0xffffff); // soft white light
  // ambient_light.intensity = 2.6;
  // scene.add(ambient_light);

  let dirLight;

  dirLight = new THREE.DirectionalLight(0xffffff, 4 * 0.8);
  dirLight.position.set(0, 0, 50);
  scene.add(dirLight);

  // let lightHelper = new THREE.DirectionalLightHelper(dirLight);
  // scene.add(lightHelper);

  dirLight = new THREE.DirectionalLight(0xffffff, 2 * 0.8);
  dirLight.position.set(-50, 0, 0);
  scene.add(dirLight);

  dirLight = new THREE.DirectionalLight(0xffffff, 3 * 0.8);
  dirLight.position.set(0, 50, 0);
  scene.add(dirLight);

  dirLight = new THREE.DirectionalLight(0xffffff, 2 * 0.8);
  dirLight.position.set(0, -50, 0);
  scene.add(dirLight);

  section_renderer_box = new THREE.Box3();
  section_renderer_box.setFromCenterAndSize(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(2, section_view_size * 2, section_view_size * 2),
  );
  section_renderer_box_helper = new THREE.Box3Helper(section_renderer_box, 0xdddddd);
  section_renderer_box_helper.layers.disable(1);
  scene.add(section_renderer_box_helper);

  animate();
}

function initGUI() {
  const gui = new GUI();

  let guiViewSettings = gui.addFolder('View Settings');
  guiViewSettings.open();

  guiLayersFolder = gui.addFolder('Layers');
  guiLayersFolder.open();

  guiInstancesFolder = gui.addFolder('Cells/Instances');
  guiInstancesFolder.close();

  let guiPerformanceSettings = gui.addFolder('Performance');
  guiPerformanceSettings.close();

  let guiExperimentalSettings = gui.addFolder('Experimental');
  guiExperimentalSettings.open();

  // View Settings
  viewSettings['isoleate_selection_or_back'] = function () {
    isolateSelectionOrGoBack();
  };
  guiIsolateSelectionButton = guiViewSettings.add(viewSettings, 'isoleate_selection_or_back');
  guiIsolateSelectionButton.name('Isolate selection / Back');
  guiIsolateSelectionButton.disable();

  viewSettings['zoom_selection'] = function () {
    zoomSelection();
  };
  guiZoomSelectionButton = guiViewSettings.add(viewSettings, 'zoom_selection');
  guiZoomSelectionButton.name('Zoom selection');
  guiZoomSelectionButton.disable();

  guiViewSettings
    .add(viewSettings, 'filler_cells')
    .name('Filler cells')
    .listen()
    .onChange(function (new_value) {
      setFillerCellsVisibility(new_value);
    });
  guiViewSettings
    .add(viewSettings, 'top_cell_geometry')
    .name('Top cell geometry')
    .listen()
    .onChange(function (new_value) {
      setTopCellGeometryVisibility(new_value);
    });

  // List instances
  viewSettings.instances['_ ALL _'] = true;
  viewSettings.instances['_ SORT_BY _'] = 'Name';
  viewSettings.instances['list'] = [];
  guiInstancesFolder
    .add(viewSettings.instances, '_ ALL _')
    .name('ALL')
    .onChange(function (new_value) {
      for (let cell_name in GDS.view_stats.instances) {
        viewSettings.instances.list[cell_name] = new_value;
        setCellVisibility(cell_name, new_value);
      }
    });
  guiInstancesFolder
    .add(viewSettings.instances, '_ SORT_BY _')
    .options(['Name', 'Count'])
    .name('Sort By')
    .onChange(function (new_value) {
      buildInstancesNamesFolder(new_value);
    });

  // Performance Settings
  guiPerformanceSettings
    .add(performanceSettings, 'logarithmicDepthBuffer')
    .onChange(function (new_value) {
      resetRenderer(performanceSettings.antialias, performanceSettings.logarithmicDepthBuffer);
    });
  guiPerformanceSettings.add(performanceSettings, 'antialias').onChange(function (new_value) {
    resetRenderer(performanceSettings.antialias, performanceSettings.logarithmicDepthBuffer);
  });
  guiPerformanceSettings.add(performanceSettings, 'Show FPS').onChange(function (new_value) {
    show_fps_stats = new_value;
    fps_stats.domElement.hidden = !show_fps_stats;
  });

  // Experimental Settings
  guiExperimentalSettings.add(experimentalSettings, 'Show section').onChange(function (new_value) {
    setSectionViewVisibility(new_value);
  });
  experimentalSettings['Section size'] = section_view_size;
  guiExperimentalSettings
    .add(experimentalSettings, 'Section size', 3, 20, 0.1)
    .onChange(function (new_value) {
      section_view_size = new_value;
      updateSectionCamera();
    });
  guiExperimentalSettings
    .add(experimentalSettings, 'B&W depth colors')
    .onChange(function (new_value) {
      setBWModeOn(new_value);
    });
  guiExperimentalSettings.add(experimentalSettings, 'Auto rotation').onChange(function (new_value) {
    experimental_auto_rotation = new_value;
  });
  guiExperimentalSettings
    .add(experimentalSettings, 'Rotation speed', 0.0001, 0.05, 0.0005)
    .onChange(function (new_value) {
      experimental_auto_rotation_speed = new_value;
    });
  guiExperimentalSettings
    .add(experimentalSettings, 'Separate layers', 0, 10, 0.01)
    .onChange(function (new_value) {
      experimental_separate_layers_target = new_value;
    });
}

function updateGuiAfterLoad() {
  loadingStatus.hidden = true;
  viewSettings.layers_visibility['ALL'] = true;

  // Layers visibility
  guiLayersFolder.add(viewSettings.layers_visibility, 'ALL').onChange(function (new_value) {
    for (const [layer_id, layer] of Object.entries(GDS.layers)) {

      let material_visibility_prop = guiLayersFolder.children.find(function (child) {
        return child.property == layer.name;
      });

      material_visibility_prop.setValue(new_value);
    }
  });

  for (const [layer_id, layer] of Object.entries(GDS.layers)) {
    viewSettings.layers[layer.name] = layer;
    viewSettings.layers_visibility[layer.name] = true;
    let widget = guiLayersFolder
      .add(viewSettings.layers_visibility, layer.name)
      .onChange(function (new_value) {
        if (new_value) {
          camera.layers.enable(getTHREEJSLayerFromGDSLayer(viewSettings.layers[this._name]));
          section_camera.layers.enable(getTHREEJSLayerFromGDSLayer(viewSettings.layers[this._name]));
          raycaster.layers.enable(getTHREEJSLayerFromGDSLayer(viewSettings.layers[this._name]));
        } else {
          camera.layers.disable(getTHREEJSLayerFromGDSLayer(viewSettings.layers[this._name]));
          section_camera.layers.disable(getTHREEJSLayerFromGDSLayer(viewSettings.layers[this._name]));
          raycaster.layers.disable(getTHREEJSLayerFromGDSLayer(viewSettings.layers[this._name]));
        }
      });
    widget.domElement.style =
      'border-left: 5px solid #' + layer.threejs_material.color.getHexString(THREE.LinearSRGBColorSpace) + ';';
  }

  // buildInstancesNamesFolder(viewSettings.instances['_ SORT_BY _']);
}

function buildInstancesNamesFolder(sorted_by, rebuild = false) {
  if (guiInstancesNamesFolder) {
    guiInstancesNamesFolder.destroy();
  }

  let sorted_cell_names = Object.keys(GDS.view_stats.instances);

  guiInstancesNamesFolder = guiInstancesFolder.addFolder(
    'Cell types: ' +
    sorted_cell_names.length +
    ' - Instances: ' +
    GDS.view_stats.total_instances,
  );

  if (sorted_by == 'Name') {
    sorted_cell_names.sort();
  } else {
    sorted_cell_names.sort(function (a, b) {
      return GDS.view_stats.instances[b] - GDS.view_stats.instances[a];
    });
  }

  for (let i in sorted_cell_names) {
    const cell_name = sorted_cell_names[i];
    if (rebuild) viewSettings.instances.list[cell_name] = true;
    guiInstancesNamesFolder
      .add(viewSettings.instances.list, cell_name)
      .name(cell_name + ' (x' + GDS.view_stats.instances[cell_name] + ')')
      .listen()
      .onChange(function (new_value) {
        setCellVisibility(cell_name, new_value);
      });
  }
}

function animate() {
  requestAnimationFrame(animate);

  // Elapsed time for framerate independent animation
  let elapsed_time_ms = performance.now() - animation_last_time;
  animation_last_time = performance.now();

  // Auto rotation
  if (experimental_auto_rotation && scene_root_group) {
    let scene_center = new THREE.Vector3();
    GDS.root_node.scene_bounding_box.getCenter(scene_center);
    let mov_x = scene_center.x;
    let mov_y = scene_center.y;
    scene_root_group.translateX(mov_x);
    scene_root_group.translateY(mov_y);
    scene_root_group.rotateZ(experimental_auto_rotation_speed * (elapsed_time_ms / 60));
    scene_root_group.translateX(-mov_x);
    scene_root_group.translateY(-mov_y);
  }

  // Separate Layers
  if (experimental_separate_layers_level != experimental_separate_layers_target) {
    const ease_ratio = 0.2;
    experimental_separate_layers_level =
      experimental_separate_layers_level * (1 - ease_ratio) +
      ease_ratio * experimental_separate_layers_target;
    if (Math.abs(experimental_separate_layers_level - experimental_separate_layers_target) < 0.01) {
      experimental_separate_layers_level = experimental_separate_layers_target;
    }

    for(let mesh_name in GDS.meshes) {
      const mesh = GDS.meshes[mesh_name];
      const layer_order = GDS.layers[GDS.makeLayerId(mesh.layer_number, mesh.layer_datatype)].visual_order;
      mesh.threejs_instanced_mesh.position.z = experimental_separate_layers_level * layer_order;
    }
  }

  
  // B&W mode
  if (!experimental_bw_mode_on) {
    scene.background = new THREE.Color(0x606060);
  } else {
    scene.background = new THREE.Color(0);
  }

  // Main render
  renderer.render(scene, camera);

  // Section view
  if (experimental_show_section_on) {
    scene.background = new THREE.Color(0);
    section_renderer.render(scene, section_camera);
  }

  // Debug FPS
  if (show_fps_stats) fps_stats.update();
}

function setCellVisibility(cell_name, visible) {
  const meshes_names = GDS.cells[cell_name].meshes_names;

  for (let i = 0; i < meshes_names.length; i++) {
    if (GDS.meshes[meshes_names[i]].threejs_instanced_mesh != null)
      GDS.meshes[meshes_names[i]].threejs_instanced_mesh.visible = visible;
  }
}

function setSectionViewVisibility(sectionViewEnabled) {
  experimental_show_section_on = sectionViewEnabled;
  section_renderer.domElement.parentElement.hidden = !sectionViewEnabled;
  section_renderer_box_helper.visible = sectionViewEnabled;
}

function isFillerCell(name) {
  // IHP sg13g2:
  if (name.startsWith('sg13g2_') && (name.indexOf('_fill_') >= 0 || name.indexOf('_decap_') >= 0)) {
    return true;
  }

  // Skywater 130:
  return (
    name.indexOf('__fill') != -1 || name.indexOf('__decap') != -1 || name.indexOf('__tap') != -1
  );
}

function setFillerCellsVisibility(visible) {
  const instances_changed = [];

  viewSettings.filler_cells = visible;

  // ToDo: Maintaing a list of cells used in current view. Use GDS.view_stats?  
  for (let cell_name in GDS.cells) {
    if (isFillerCell(cell_name)) {
      setCellVisibility(cell_name, visible);

      viewSettings.instances.list[cell_name] = visible;//instances_changed[instance_name];
    }

  }

}

function setTopCellGeometryVisibility(visible) {
  viewSettings.top_cell_geometry = visible;

  const cell = GDS.cells[GDS.root_node.cell_name];

  for (let i = 0; i < cell.meshes_names.length; i++) {
    const mesh = GDS.meshes[cell.meshes_names[i]];
    const layer_name = GDS.layers[GDS.makeLayerId(mesh.layer_number, mesh.layer_datatype)].name;
    if (layer_name != "substrate")
      mesh.threejs_instanced_mesh.visible = visible;
  }

  // for (var i = 0; i < GDS.root_node.children.length; i++) {
  //   const node = GDS.root_node.children[i];
  //   if (node.mesh != undefined) {
  //     if (parser.instancedMeshes[node.mesh].material.name != 'substrate')
  //       parser.instancedMeshes[node.mesh].visible = visile;
  //   }
  // }
}

function setBWModeOn(bw_mode_on) {
  experimental_bw_mode_on = bw_mode_on;

  let index = 0;
  for(let layer_id in GDS.layers) {
    const material = GDS.layers[layer_id].threejs_material;
    if (bw_mode_on) {
      experimental_bw_mode_prev_state.push({
        metalness: material.metalness,
        roughness: material.roughness,
        color: material.color.clone(),
      });
      material.metalness = 0;
      material.roughness = 1;
      material.color.r =
        material.color.g =
        material.color.b =
        0.06 + 0.04 * index;
      
      
    } else {
      material.metalness = experimental_bw_mode_prev_state[index].metalness;
      material.roughness = experimental_bw_mode_prev_state[index].roughness;
      material.color = experimental_bw_mode_prev_state[index].color.clone();
    }

    index++;
  }
}

function clearSelection() {
  turnOffHighlight();
  informationDiv.innerHTML = '';
  if (isolation_history && isolation_history.length > 0) {
    const back_node = isolation_history[isolation_history.length - 1];
    const item = document.createElement('div');
    item.innerHTML =
      "back to <a href='#'>" + back_node.instance_name + ' </a>( ' + back_node.cell_name + ' )';
    item.className = 'selection_link';
    item.onmousedown = function () {
      isolation_history.pop();
      buildScene(back_node);
    };
    informationDiv.appendChild(item);

    guiIsolateSelectionButton.enable();
    guiIsolateSelectionButton.name('Back to ' + back_node.instance_name);
  } else {
    guiIsolateSelectionButton.name('Isolate selection / Back');
    guiIsolateSelectionButton.disable();
  }
  guiZoomSelectionButton.name('Zoom selection');
  guiZoomSelectionButton.disable();

  selected_object = undefined;
  if (selection_helper) {
    scene_root_group.remove(selection_helper);
    // selection_helper = undefined;
  }
}

function selectNode(graph_node) {
  // Display selection info:
  let infoHTML = '<br />SELECTION:<br />';
  informationDiv.innerHTML += infoHTML;
  let tree_list = [];
  let current_node = graph_node;
  while (current_node != undefined) {
    tree_list.push(current_node);
    current_node = current_node.parent;
  }
  let padding = 0;
  for (let j = tree_list.length - 1; j >= 0; j--) {
    const item = document.createElement('div');
    const tree_node = tree_list[j];
    // const class_text = tree_node.instance_name ? '( ' + tree_node.cell_name + ' )' : '';
    // item.innerHTML = "<a href='#'>" + tree_node.instance_name + ' </a>' + class_text;

    if (tree_node.instance_name) {
      item.innerHTML = "<a href='#'>" + tree_node.instance_name + ' </a>' + '( ' + tree_node.cell_name + ' )';
    } else {
      item.innerHTML = "<a href='#'>" + tree_node.cell_name + ' </a>';
    }

    item.className = 'selection_link';
    item.style.paddingLeft = padding + 'px';
    item.onmousedown = function () {
      isolation_history.push(GDS.root_node);
      buildScene(tree_node);
    };
    informationDiv.appendChild(item);
    padding += 5;
  }
  // informationDiv.innerHTML = infoHTML;

  selected_object = graph_node;
  highlightObject(graph_node);


  if (selection_helper == undefined) {
    selection_helper = new THREE.Box3Helper(selected_object.scene_bounding_box);
  } else {
    selection_helper.box = selected_object.scene_bounding_box;
  }

  scene_root_group.add(selection_helper);

  guiIsolateSelectionButton.enable();
  guiIsolateSelectionButton.name('Isolate: ' + graph_node.instance_name);

  guiZoomSelectionButton.enable();
  guiZoomSelectionButton.name('Zoom: ' + graph_node.instance_name);
}

function isolateSelectionOrGoBack() {
  if (selected_object) {
    if (selected_object != GDS.root_node) {
      isolation_history.push(GDS.root_node);
      buildScene(selected_object);
    }
  } else {
    if (isolation_history.length > 0) {
      buildScene(isolation_history.pop());
    }
  }
}

function zoomNode(node) {
  if (node) {
    const bbox = node.scene_bounding_box;
    let center = new THREE.Vector3();

    bbox.getCenter(center);


    setCameraPositionForFitInView(bbox, camera);
    camera.up.x = 0;
    camera.up.y = 1;
    camera.up.z = 0;
    camera.lookAt(center.x, center.y, 0);
    // camera.lookAt(center.x, 0, center.z);
    camera.updateProjectionMatrix();

    if (cameraControls) cameraControls.dispose();
    createCameraControls(new THREE.Vector3(center.x, center.y, 0))

  }
}


function createCameraControls(target) {
  cameraControls = new OrbitControls.OrbitControls(camera, renderer.domElement);
  cameraControls.target.copy(target);
  cameraControls.update();
  // cameraControls.enableDamping = true;
  // cameraControls.dampingFactor = 0.2;
}


function zoomSelection() {
  if (selected_object) {
    zoomNode(selected_object);
  }
}

function highlightObject(graph_node) {
  highlighted_objects.push(graph_node);

  const cell = GDS.cells[graph_node.cell_name];

  for (let i = 0; i < cell.meshes_names.length; i++) {
    const color = new THREE.Color();
    const instancedMesh = GDS.meshes[cell.meshes_names[i]].threejs_instanced_mesh;

    instancedMesh.getColorAt(graph_node.instanced_mesh_idx, color);
    highlighted_prev_colors.push(color.clone());

    instancedMesh.setColorAt(graph_node.instanced_mesh_idx, highlight_color);
    instancedMesh.instanceColor.needsUpdate = true;
  }

}

function turnOffHighlight() {
  for (let i = 0; i < highlighted_objects.length; i++) {
    const graph_node = highlighted_objects[i];

    const cell = GDS.cells[graph_node.cell_name];
    for (let i = 0; i < cell.meshes_names.length; i++) {
      const instancedMesh = GDS.meshes[cell.meshes_names[i]].threejs_instanced_mesh;
      instancedMesh.setColorAt(
        graph_node.instanced_mesh_idx,
        highlighted_prev_colors[i].clone(),
      );
      instancedMesh.instanceColor.needsUpdate = true;
    }
  }
  highlighted_objects = [];
  highlighted_prev_colors = [];
}

function getCameraPositionForFitInView(bounding_box, new_position) {
  const extra = 1.1;
  let size = new THREE.Vector3();
  bounding_box.getSize(size);

  let center = new THREE.Vector3();
  bounding_box.getCenter(center);

  let fov_radians = (camera.fov / 180) * Math.PI;

  let camera_z = Math.max(
    (size.y * extra) / 2 / Math.tan(fov_radians / 2),
    (size.x * extra) / 2 / camera.aspect / Math.tan(fov_radians / 2),
  );

  // The distance is calculated to the rectangle (x,z) closest to the camera
  camera_z = camera_z + bounding_box.max.z;

  new_position.set(center.x, center.y, camera_z);

}
function setCameraPositionForFitInView(bounding_box, target_camera) {
  getCameraPositionForFitInView(bounding_box, target_camera.position);
}


// function setCameraPositionForFitInView(bounding_box) {
//   const extra = 1.1;
//   let size = new THREE.Vector3();
//   bounding_box.getSize(size);

//   let center = new THREE.Vector3();
//   bounding_box.getCenter(center);

//   let fov_radians = (camera.fov / 180) * Math.PI;

//   let camera_y = Math.max(
//     (size.z * extra) / 2 / Math.tan(fov_radians / 2),
//     (size.x * extra) / 2 / camera.aspect / Math.tan(fov_radians / 2),
//   );

//   // The distance is calculated to the rectangle (x,z) closest to the camera
//   camera_y = camera_y + bounding_box.max.y;

//   camera.position.set(center.x, camera_y, center.z);
// }

function resetRenderer() {
  if (renderer != undefined) {
    document.body.removeChild(document.getElementById('MAIN_RENDERER'));
    renderer.dispose();
  }

  renderer = new THREE.WebGLRenderer({
    antialias: performanceSettings.antialias,
    logarithmicDepthBuffer: performanceSettings.logarithmicDepthBuffer,
  });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.domElement.id = 'MAIN_RENDERER';
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  document.body.appendChild(renderer.domElement);

  let target = new THREE.Vector3();
  if (cameraControls) {
      target = cameraControls.target.clone();
      cameraControls.dispose();
  }
  createCameraControls(target);
}

window.onresize = function () {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
};

window.onkeypress = function (event) {
  if (event.key == '1') {
    setFillerCellsVisibility(!viewSettings.filler_cells);
  } else if (event.key == '2') {
    setTopCellGeometryVisibility(!viewSettings.top_cell_geometry);
  } else if (event.key == '3') {
    isolateSelectionOrGoBack();
  } else if (event.key == '4') {
    zoomSelection();
  }
};

window.onmousemove = function (event) {
  mouse_moved = true;

  let mouse = new THREE.Vector3();
  let pos = new THREE.Vector3();

  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  mouse.z = 0.5;

  mouse.unproject(camera);
  mouse.sub(camera.position).normalize();

  let ray = new THREE.Ray(camera.position, mouse);
  let plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -2);
  let point = new THREE.Vector3();
  ray.intersectPlane(plane, point);

  // section_camera.position.x = point.x;
  section_camera.position.x = point.x;
  section_camera.position.y = point.y;
  section_camera.near = -1;
  section_camera.far = 1;
  section_camera.updateProjectionMatrix();
  

  let camera_width = section_camera.right - section_camera.left;
  let camera_height = section_camera.top - section_camera.bottom;
  section_renderer_box.set(
    new THREE.Vector3(
      section_camera.position.x + section_camera.near,
      section_camera.position.y - camera_width / 2,
      section_camera.position.z - camera_height / 2,
    ),
    new THREE.Vector3(
      section_camera.position.x + section_camera.far,
      section_camera.position.y + camera_width / 2,
      section_camera.position.z + camera_height / 2,
    ),
  );
};

window.onmousedown = function (event) {
  if (event.target != renderer.domElement) return;
  mouse_down_time = performance.now();
  mouse_moved = false;
};

window.onmouseup = function (event) {
  if (event.target != renderer.domElement) return;

  const elapsed_time_ms = performance.now() - mouse_down_time;
  if (event.button != 0 || (elapsed_time_ms > 100 && mouse_moved)) return;

  clearSelection();

  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  const intersections = raycaster.intersectObject(scene, true);

  // console.log("Raycast intersections:");
  if (intersections.length > 0) {
    for (var i = 0; i < intersections.length; i++) {
      // console.log(intersections[i].object);

      if (intersections[i].object.isInstancedMesh && intersections[i].object.visible) {
        let mesh = intersections[i].object;
        let instanceId = intersections[i].instanceId;

        let clicked_node = GDS.meshes[mesh.name].instances[instanceId].node;


        selectNode(clicked_node);

        // let mesh_idx = parser.instancedMeshes.indexOf(mesh);

        // if (mesh_idx != -1) {
        //   let node_idx = parser.mesh_instances[mesh_idx].instances[instanceId].parent_node_idx;
        //   // console.log(node_idx);
        //   let graph_node = node_graph.findNodeById(node_graph, node_idx);
        //   selectNode(graph_node);
        // }

        // Just first intersection
        break;
      }
    }
  }
};

function getTHREEJSLayerFromGDSLayer(gds_layer) {
  return getTHREEJSLayerFromGDSLayerId(GDS.makeLayerId(gds_layer.layer_number, gds_layer.layer_datatype));
}

function getTHREEJSLayerFromGDSLayerId(gds_layer_id) {
  return Object.keys(GDS.layers).indexOf(gds_layer_id) + 1;
}


function updateSectionCamera() {
  section_camera.left = -section_view_size;
  section_camera.right = section_view_size;
  section_camera.top = section_view_size;
  section_camera.bottom = -section_view_size;
}

function cleanScene() {
  clearSelection();

  for (const mesh_name in GDS.meshes) {

    let mesh = GDS.meshes[mesh_name];
    if (mesh.instances.length == 0)
      continue;

    if (mesh.threejs_lines != null)
      mesh.threejs_lines.geometry.dispose();

    if (mesh.threejs_instanced_mesh != null)
      mesh.threejs_instanced_mesh.dispose();

    mesh.instances = [];
  }


  if (scene_root_group != undefined) {
    scene.remove(scene_root_group);

    //  scene_root_group = undefined; ??
  }

  GDS.root_node = null;
  GDS.nodes = [];

  // Stats
  GDS.view_stats = {};
  GDS.view_stats.instances = {};
  GDS.view_stats.total_instances = 0;

  instanceClassTitleDiv.innerHTML = "";

}


function buildSceneDoNodeCalcs(node, parent_matrix) {

  const node_matrix = node.matrix.clone();
  node_matrix.premultiply(parent_matrix);

  const cell = GDS.cells[node.cell_name];

  // Stats
  if (GDS.view_stats.instances[node.cell_name] == undefined) {
    GDS.view_stats.instances[node.cell_name] = 1;
  } else {
    GDS.view_stats.instances[node.cell_name]++;
  }
  GDS.view_stats.total_instances++;


  for (let j = 0; j < cell.meshes_names.length; j++) {
    let mesh_bounding_box;
    const mesh_name = cell.meshes_names[j];

    let instance_data = {
      name: mesh_name,
      matrix: node_matrix,
      node: node
    };

    GDS.meshes[mesh_name].instances.push(instance_data);

    mesh_bounding_box = GDS.meshes[mesh_name].threejs_mesh.geometry.boundingBox.clone();
    mesh_bounding_box.applyMatrix4(node_matrix);

    if (node.scene_bounding_box == null) {
      node.scene_bounding_box = mesh_bounding_box.clone();
    } else {
      node.scene_bounding_box.union(mesh_bounding_box);
    }
  }


  for (let i = 0; i < GDS.cells[node.cell_name].references.length; i++) {
    const child_ref = GDS.cells[node.cell_name].references[i];
    const child_node = GDS.addNode(child_ref.cell_name, child_ref.instance_name, child_ref.matrix, node);

    // const matrix = child_node.matrix.clone();
    // matrix.premultiply(node_matrix);

    // if (child_node.children.length > 0) {
    buildSceneDoNodeCalcs(child_node, node_matrix);
    if (node.scene_bounding_box == null) {
      node.scene_bounding_box = child_node.scene_bounding_box.clone();
    } else {
      node.scene_bounding_box.union(child_node.scene_bounding_box);

    }
    // }
    node.children.push(child_node);
  }

  if (node.scene_bounding_box == null) {
    node.scene_bounding_box = new THREE.Box3();
  }

  // node.scene_bounding_box = node_bounding_box;
}


function buildMeshesScene(top_node, main_matrix) {

  let main_bounding_box = undefined;

  for (const mesh_name in GDS.meshes) {
    let mesh = GDS.meshes[mesh_name];
    if (mesh.instances.length == 0)
      continue;

    let reference_mesh = mesh.threejs_mesh;

    // Create Instanced Mesh
    let instanced_mesh = new THREE.InstancedMesh(
      reference_mesh.geometry,
      reference_mesh.material,
      mesh.instances.length
    );

    instanced_mesh.layers.set(getTHREEJSLayerFromGDSLayerId(GDS.makeLayerId(mesh.layer_number, mesh.layer_datatype)));

    instanced_mesh.name = reference_mesh.name;

    let color = new THREE.Color(1, 1, 1);
    for (let j = 0; j < mesh.instances.length; j++) {
      const matrix = mesh.instances[j].matrix;
      const instances_bounding_box = instanced_mesh.geometry.boundingBox.clone();

      instances_bounding_box.applyMatrix4(matrix);
      instanced_mesh.setMatrixAt(j, matrix);
      instanced_mesh.setColorAt(j, color);

      if (main_bounding_box == undefined) {
        main_bounding_box = instances_bounding_box.clone();
      } else {
        main_bounding_box.union(instances_bounding_box);
      }

      // ToDo: this gets assigned several times? Can it get different numbers? Review.
      mesh.instances[j].node.instanced_mesh_idx = j;
    }

    scene_root_group.add(instanced_mesh);
    mesh.threejs_instanced_mesh = instanced_mesh;
  }

  scene.add(scene_root_group);

}


function buildScene(node, reset_camera = true) {
  cleanScene();

  scene_root_group = new THREE.Group();

  let main_matrix = new THREE.Matrix4();

  if (node == null) {
    GDS.root_node = GDS.addNode(GDS.top_cells[0], GDS.top_cells[0], new THREE.Matrix4(), null);
  } else {
    node.scene_bounding_box = null;
    GDS.root_node = node;
  }


  buildSceneDoNodeCalcs(GDS.root_node, main_matrix);

  buildMeshesScene(GDS.root_node, main_matrix);


  if (reset_camera)
    zoomNode(GDS.root_node);

  
  if (GDS.root_node.instance_name) {
    instanceClassTitleDiv.innerHTML = GDS.root_node.instance_name + ' (' + GDS.root_node.cell_name + ')';
  } else {
    instanceClassTitleDiv.innerHTML = GDS.root_node.cell_name;
  }

  viewSettings.filler_cells = true;
  viewSettings.top_cell_geometry = true;
  buildInstancesNamesFolder(viewSettings.instances['_ SORT_BY _'], true);

}


function BORRAR_cleanScene() {
  clearSelection();

  if (parser.instancedMeshes != undefined) {
    for (let i in parser.instancedMeshes) {
      parser.instancedMeshes[i].dispose();
    }
  }

  if (scene_root_group != undefined) {
    scene.remove(scene_root_group);
  }

  parser.instancedMeshes = [];
  parser.mesh_instances = [];

  parser.stats = {};
  parser.stats.instances = {};
  parser.stats.total_nodes = parser.gltf.nodes.length;
  parser.stats.total_instances = 0;

  scene_root_group = undefined;

  node_graph = {};
  node_graph.findNodeById = function (graph, node_idx) {
    if (graph.node_idx == node_idx) return graph;

    if (graph.children != undefined) {
      for (let i = 0; i < graph.children.length; i++) {
        let found = node_graph.findNodeById(graph.children[i], node_idx);
        if (found != undefined) return found;
      }
    }
    return undefined;
  };
}

function BORRAR_buildScene(main_node_idx, reset_camera = true) {
  cleanScene();

  const main_node = parser.gltf.nodes[main_node_idx];

  let main_matrix = new THREE.Matrix4();
  main_matrix.makeRotationX(-Math.PI / 2);
  parseNode(parser, main_node_idx, main_matrix, node_graph);

  scene_root_group = new THREE.Group();
  let main_bounding_box = undefined;
  for (let i = 0; i < parser.mesh_instances.length; i++) {
    if (parser.mesh_instances[i] === undefined) continue;

    let reference_mesh = parser.meshes[parser.mesh_instances[i].mesh_idx];
    let instance_mesh = new THREE.InstancedMesh(
      reference_mesh.geometry,
      reference_mesh.material,
      parser.mesh_instances[i].instances.length,
    );
    instance_mesh.layers.set(getLayerIDFromMaterial(reference_mesh.material));

    if (reference_mesh.name !== undefined) {
      instance_mesh.name = reference_mesh.name;
    }

    let color = new THREE.Color(1, 1, 1);
    for (let j = 0; j < parser.mesh_instances[i].instances.length; j++) {
      const matrix = parser.mesh_instances[i].instances[j].matrix;
      const instances_bounding_box = instance_mesh.geometry.boundingBox.clone();

      instances_bounding_box.applyMatrix4(matrix);
      instance_mesh.setMatrixAt(j, matrix);
      instance_mesh.setColorAt(j, color);

      if (main_bounding_box == undefined) {
        main_bounding_box = instances_bounding_box.clone();
      } else {
        main_bounding_box.union(instances_bounding_box);
      }
    }
    scene_root_group.add(instance_mesh);
    parser.instancedMeshes[i] = instance_mesh;
  }

  // main_bounding_box.applyMatrix4(main_matrix);

  let center = new THREE.Vector3();
  main_bounding_box.getCenter(center);

  if (reset_camera) {
    setCameraPositionForFitInView(main_bounding_box), camera;
    camera.up.x = 0;
    camera.up.y = 0;
    camera.up.z = -1;
    camera.lookAt(center.x, 0, center.z);

    camera.updateProjectionMatrix();

    // cameraControls.target.set(center);
    if (cameraControls) cameraControls.dispose();
    cameraControls = new OrbitControls.OrbitControls(camera, renderer.domElement);
    cameraControls.target.set(center.x, 0, center.z);
    cameraControls.update();
  }

  scene.add(scene_root_group);

  instanceClassTitleDiv.innerHTML = node_graph.name;
  if (node_graph.instance_class) {
    instanceClassTitleDiv.innerHTML += ' (' + node_graph.instance_class + ')';
  }

  node_graph.bounding_box = main_bounding_box;

  viewSettings.filler_cells = true;
  viewSettings.top_cell_geometry = true;
  buildInstancesNamesFolder(viewSettings.instances['_ SORT_BY _'], true);

  //// Test for checking nodes bounding boxes
  //// Those bounding boxes could then be used to filter objects for raycasting
  // let bbox_root_group = new THREE.Group();
  // let nodes_to_add = [node_graph];
  // while(nodes_to_add.length>0) {
  //   const node = nodes_to_add.pop();

  //   for (let i = 0; node.children && i < node.children.length; i++) {
  //     nodes_to_add.push(node.children[i]);
  //   }

  //   if(node.bounding_box) {
  //     const box = new THREE.Box3Helper(node.bounding_box);
  //     bbox_root_group.add(box);
  //   }
  // }
  // scene.add(bbox_root_group);
}

function parseNode(parser_data, node_idx, parent_matrix, node_graph) {
  let gltf_node = parser_data.gltf.nodes[node_idx];

  node_graph.node_idx = node_idx;
  node_graph.name = gltf_node.name;
  node_graph.instance_class = '';
  node_graph.children = [];
  node_graph.bounding_box = undefined;

  if (gltf_node.extras != undefined && gltf_node.extras.type != undefined) {
    node_graph.instance_class = gltf_node.extras.type;

    if (parser_data.stats.instances[gltf_node.extras.type] == undefined) {
      parser_data.stats.instances[gltf_node.extras.type] = 1;
    } else {
      parser_data.stats.instances[gltf_node.extras.type]++;
    }
    parser.stats.total_instances++;
  }

  for (let i = 0; i < gltf_node.children.length; i++) {
    const gltf_child_node_idx = gltf_node.children[i];
    const gltf_child_node = parser_data.gltf.nodes[gltf_child_node_idx];

    node_graph.children[i] = {};
    node_graph.children[i].node_idx = gltf_child_node_idx;
    node_graph.children[i].parent = node_graph;

    const matrix = new THREE.Matrix4();
    let mesh_bounding_box;

    if (gltf_node.matrix !== undefined) {
      // ToDo: this code wasn't tested as the GDS generated GLTF files don't have matrix transforms
      matrix.fromArray(gltf_node.matrix);
    } else {
      let translation = new THREE.Vector3(0, 0, 0);
      let rotation = new THREE.Quaternion();
      let scale = new THREE.Vector3(1, 1, 1);

      if (gltf_node.translation !== undefined) {
        // matrix.setPosition(new THREE.Vector3().fromArray(gltf_node.translation));
        translation.fromArray(gltf_node.translation);
        // meshes[i].position.fromArray(gltf_node.translation);
      }

      if (gltf_node.rotation !== undefined) {
        // matrix.makeRotationFromEuler(new THREE.Euler().fromArray(gltf_node.rotation));
        rotation.fromArray(gltf_node.rotation);
        // meshes[i].quaternion.fromArray(gltf_node.rotation);
      }

      if (gltf_node.scale !== undefined) {
        scale.fromArray(gltf_node.scale);
        // matrix.scale(new THREE.Vector3().fromArray(gltf_node.scale));
        // meshes[i].scale.fromArray(gltf_node.scale);
      }

      matrix.compose(translation, rotation, scale);
    }

    matrix.premultiply(parent_matrix);

    if (gltf_child_node.mesh != undefined) {
      // First time loading this mesh?
      if (parser_data.meshes[gltf_child_node.mesh] == undefined) {
        parseMesh(parser_data, gltf_child_node.mesh, gltf_child_node.name);
      }

      if (parser_data.mesh_instances[gltf_child_node.mesh] == undefined) {
        parser_data.mesh_instances[gltf_child_node.mesh] = {
          mesh_idx: gltf_child_node.mesh,
          instances: [],
        };
      }

      // ToDo: this code wasn't tested as the GLTF generated from the GDS files don't have mesh nodes with transformation data
      if (gltf_child_node.matrix !== undefined) {
        // const matrix = new THREE.Matrix4();
        // matrix.fromArray(gltf_child_node.matrix);
        // node.applyMatrix4( matrix );
        // meshes[i].applyMatrix4(matrix);
      } else {
        // const matrix = new THREE.Matrix4();
        if (gltf_child_node.translation !== undefined) {
          // matrix.setPosition(new THREE.Vector3().fromArray(gltf_child_node.translation));
          // meshes[i].position.fromArray(gltf_child_node.translation);
        }
        if (gltf_child_node.rotation !== undefined) {
          // matrix.makeRotationFromEuler(new THREE.Euler().fromArray(gltf_child_node.rotation));
          // meshes[i].quaternion.fromArray(gltf_child_node.rotation);
        }
        if (gltf_child_node.scale !== undefined) {
          // meshes[i].scale.fromArray(gltf_child_node.scale);
        }
      }

      let instance_data = {
        name: gltf_node.name + '_' + gltf_child_node.name,
        matrix: matrix,
        parent_node_idx: node_idx,
      };
      parser_data.mesh_instances[gltf_child_node.mesh].instances.push(instance_data);

      node_graph.children[i].mesh = gltf_child_node.mesh;
      node_graph.children[i].instanced_mesh_instance =
        parser_data.mesh_instances[gltf_child_node.mesh].instances.length - 1;

      mesh_bounding_box = parser_data.meshes[gltf_child_node.mesh].geometry.boundingBox.clone();
      mesh_bounding_box.applyMatrix4(matrix);

      if (node_graph.bounding_box == undefined) {
        node_graph.bounding_box = mesh_bounding_box.clone();
      } else {
        node_graph.bounding_box.union(mesh_bounding_box);
      }
    }

    if (gltf_child_node.children != undefined && gltf_child_node.children.length > 0) {
      parseNode(parser_data, gltf_child_node_idx, matrix, node_graph.children[i]);

      if (node_graph.bounding_box == undefined) {
        node_graph.bounding_box = node_graph.children[i].bounding_box.clone();
      } else {
        node_graph.bounding_box.union(node_graph.children[i].bounding_box);
      }
    }
  }
}
