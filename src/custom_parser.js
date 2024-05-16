/*

Custom parser based on three.js GLTFLoader to be able to generate THREE.InstancedMesh objects for instances that came from the GDS, specially standard cells that repeat a lot.
This way we reduce the number of opengl draw calls without the need to flatten the GDS and allowing us to highlight cells or isolate them. 
The code is just an adaptation of this: https://github.com/mrdoob/three.js/blob/a2e9ee8204b67f9dca79f48cf620a34a05aa8126/examples/jsm/loaders/GLTFLoader.js, 
made specifically to parse the GLTF files that are generated on the Tiny Tapeout template github actions

*/

import * as THREE from 'three';

const WEBGL_TYPE_SIZES = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

const WEBGL_CONSTANTS = {
  FLOAT: 5126,
  //FLOAT_MAT2: 35674,
  FLOAT_MAT3: 35675,
  FLOAT_MAT4: 35676,
  FLOAT_VEC2: 35664,
  FLOAT_VEC3: 35665,
  FLOAT_VEC4: 35666,
  LINEAR: 9729,
  REPEAT: 10497,
  SAMPLER_2D: 35678,
  POINTS: 0,
  LINES: 1,
  LINE_LOOP: 2,
  LINE_STRIP: 3,
  TRIANGLES: 4,
  TRIANGLE_STRIP: 5,
  TRIANGLE_FAN: 6,
  UNSIGNED_BYTE: 5121,
  UNSIGNED_SHORT: 5123,
};

const ATTRIBUTES = {
  POSITION: 'position',
  NORMAL: 'normal',
  TANGENT: 'tangent',
  TEXCOORD_0: 'uv',
  TEXCOORD_1: 'uv1',
  TEXCOORD_2: 'uv2',
  TEXCOORD_3: 'uv3',
  COLOR_0: 'color',
  WEIGHTS_0: 'skinWeight',
  JOINTS_0: 'skinIndex',
};

const WEBGL_COMPONENT_TYPES = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};

const ALPHA_MODES = {
  OPAQUE: 'OPAQUE',
  MASK: 'MASK',
  BLEND: 'BLEND',
};

export function parseGLTF(parser_data, gltf_file) {
  // parser_data = {};
  parser_data.gltf = gltf_file;
  parser_data.materials = [];
  parser_data.meshes = [];
  parser_data.accessors = [];
  parser_data.bufferViews = [];
  parser_data.buffers = [];

  parser_data.gltf_root_node_idx = parser_data.gltf.scenes[parser_data.gltf.scene].nodes[0]; //22163; // 17502;

  const pending = [];

  for (let i = 0; i < parser_data.gltf.buffers.length; i++) {
    pending.push(
      loadBuffer(parser_data.gltf.buffers[i]).then(function (buffer) {
        parser_data.buffers[i] = buffer;
      }),
    );
  }

  // After buffers loaded
  return Promise.all(pending).then(function () {
    for (let i = 0; i < parser_data.gltf.bufferViews.length; i++) {
      parser_data.bufferViews[i] = loadBufferView(parser_data, parser_data.gltf.bufferViews[i]);
    }
    for (let i = 0; i < parser_data.gltf.accessors.length; i++) {
      parser_data.accessors[i] = loadAccessor(parser_data, parser_data.gltf.accessors[i]);
    }

    for (let i = 0; i < parser_data.gltf.materials.length; i++) {
      parser_data.materials[i] = parseMaterial(parser_data, parser_data.gltf.materials[i]);
    }
  });
}

export function parseMesh(parser_data, mesh_idx, node_name) {
  const meshDef = parser_data.gltf.meshes[mesh_idx];
  const primitives = meshDef.primitives;

  const geometries = loadGeometries(parser_data, primitives);

  // ToDo: right now this doesn't work correctly if there are more that 1 primitive per mesh
  // The gltf files we are generating doesn't have more than 1
  for (let i = 0, il = geometries.length; i < il; i++) {
    const geometry = geometries[i];
    const primitive = primitives[i];

    let mesh;

    const material_idx = primitive.material;
    const material = parser_data.materials[material_idx];

    if (
      primitive.mode === WEBGL_CONSTANTS.TRIANGLES ||
      primitive.mode === WEBGL_CONSTANTS.TRIANGLE_STRIP ||
      primitive.mode === WEBGL_CONSTANTS.TRIANGLE_FAN ||
      primitive.mode === undefined
    ) {
      // .isSkinnedMesh isn't in glTF spec. See ._markDefs()
      mesh =
        meshDef.isSkinnedMesh === true
          ? new THREE.SkinnedMesh(geometry, material)
          : new THREE.Mesh(geometry, material);

      if (mesh.isSkinnedMesh === true) {
        // normalize skin weights to fix malformed assets (see #15319)
        mesh.normalizeSkinWeights();
      }

      if (primitive.mode === WEBGL_CONSTANTS.TRIANGLE_STRIP) {
        throw new Error('GLTF Parser: TRIANGLE_STRIP not implemented yet');
        // mesh.geometry = toTrianglesDrawMode(mesh.geometry, TriangleStripDrawMode);
      } else if (primitive.mode === WEBGL_CONSTANTS.TRIANGLE_FAN) {
        throw new Error('GLTF Parser: TRIANGLE_FAN not implemented yet');
        // mesh.geometry = toTrianglesDrawMode(mesh.geometry, TriangleFanDrawMode);
      }
    } else if (primitive.mode === WEBGL_CONSTANTS.LINES) {
      mesh = new THREE.LineSegments(geometry, material);
    } else if (primitive.mode === WEBGL_CONSTANTS.LINE_STRIP) {
      mesh = new THREE.Line(geometry, material);
    } else if (primitive.mode === WEBGL_CONSTANTS.LINE_LOOP) {
      mesh = new THREE.LineLoop(geometry, material);
    } else if (primitive.mode === WEBGL_CONSTANTS.POINTS) {
      mesh = new THREE.Points(geometry, material);
    } else {
      throw new Error('GLTF Parser: Primitive mode unsupported: ' + primitive.mode);
    }

    mesh.name = meshDef.name || node_name || 'mesh_' + mesh_idx;

    assignExtrasToUserData(mesh, meshDef);

    parser_data.meshes[mesh_idx] = mesh;

    // assignFinalMaterial( mesh );
  }
}

function base64ToArrayBuffer(base64) {
  var binaryString = atob(base64);
  var bytes = new Uint8Array(binaryString.length);
  for (var i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function loadGeometries(parser_data, primitives) {
  let geometries = [];

  for (let i = 0, il = primitives.length; i < il; i++) {
    geometries[i] = addPrimitiveAttributes(parser_data, new THREE.BufferGeometry(), primitives[i]);
  }

  return geometries;
}

function loadBuffer(bufferDef) {
  if (bufferDef.type && bufferDef.type !== 'arraybuffer') {
    throw new Error('GLTF Parser: ' + bufferDef.type + ' buffer type is not supported.');
  }

  return new Promise(function (resolve, reject) {
    // THREE.FileLoader wasn't working with big data URLS (data:).
    // Had to replace with a base64 to ArrayBuffer function directly

    // bufferDef.uri contains: "data:application/octet-stream;base64,xxxxxxxxx"
    resolve(base64ToArrayBuffer(bufferDef.uri.substring(37)));

    // parser_data.fileLoader.load(bufferDef.uri, resolve, undefined, function () {
    //     reject(new Error('GLTF Parser: Failed to load buffer "' + bufferDef.uri + '".'));
    // });
  });
}

function loadBufferView(parser_data, bufferViewDef) {
  const byteLength = bufferViewDef.byteLength || 0;
  const byteOffset = bufferViewDef.byteOffset || 0;
  let buffer = parser_data.buffers[bufferViewDef.buffer];
  return buffer.slice(byteOffset, byteOffset + byteLength);
}

function loadAccessor(parser_data, accessorDef) {
  if (accessorDef.bufferView === undefined && accessorDef.sparse === undefined) {
    const itemSize = WEBGL_TYPE_SIZES[accessorDef.type];
    const TypedArray = WEBGL_COMPONENT_TYPES[accessorDef.componentType];
    const normalized = accessorDef.normalized === true;

    const array = new TypedArray(accessorDef.count * itemSize);
    return new THREE.BufferAttribute(array, itemSize, normalized);
  }

  const bufferView = parser_data.bufferViews[accessorDef.bufferView];

  const itemSize = WEBGL_TYPE_SIZES[accessorDef.type];
  const TypedArray = WEBGL_COMPONENT_TYPES[accessorDef.componentType];

  // For VEC3: itemSize is 3, elementBytes is 4, itemBytes is 12.
  const elementBytes = TypedArray.BYTES_PER_ELEMENT;
  const itemBytes = elementBytes * itemSize;
  const byteOffset = accessorDef.byteOffset || 0;
  const byteStride =
    accessorDef.bufferView !== undefined
      ? parser_data.bufferViews[accessorDef.bufferView].byteStride
      : undefined;
  const normalized = accessorDef.normalized === true;
  let array, bufferAttribute;

  // The buffer is not interleaved if the stride is the item size in bytes.
  if (byteStride && byteStride !== itemBytes) {
    // Each "slice" of the buffer, as defined by 'count' elements of 'byteStride' bytes, gets its own InterleavedBuffer
    // This makes sure that IBA.count reflects accessor.count properly
    const ibSlice = Math.floor(byteOffset / byteStride);
    const ibCacheKey =
      'InterleavedBuffer:' +
      accessorDef.bufferView +
      ':' +
      accessorDef.componentType +
      ':' +
      ibSlice +
      ':' +
      accessorDef.count;

    array = new TypedArray(
      bufferView,
      ibSlice * byteStride,
      (accessorDef.count * byteStride) / elementBytes,
    );
    // Integer parameters to IB/IBA are in array elements, not bytes.
    // ib = new InterleavedBuffer(array, byteStride / elementBytes);
    let ib = new THREE.InterleavedBuffer(array, byteStride / elementBytes);

    bufferAttribute = new THREE.InterleavedBufferAttribute(
      ib,
      itemSize,
      (byteOffset % byteStride) / elementBytes,
      normalized,
    );
  } else {
    if (bufferView === null) {
      array = new TypedArray(accessorDef.count * itemSize);
    } else {
      array = new TypedArray(bufferView, byteOffset, accessorDef.count * itemSize);
    }
    bufferAttribute = new THREE.BufferAttribute(array, itemSize, normalized);
  }

  // https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#sparse-accessors
  if (accessorDef.sparse !== undefined) {
    const itemSizeIndices = WEBGL_TYPE_SIZES.SCALAR;
    const TypedArrayIndices = WEBGL_COMPONENT_TYPES[accessorDef.sparse.indices.componentType];

    const byteOffsetIndices = accessorDef.sparse.indices.byteOffset || 0;
    const byteOffsetValues = accessorDef.sparse.values.byteOffset || 0;

    const sparseIndices = new TypedArrayIndices(
      bufferViews[1],
      byteOffsetIndices,
      accessorDef.sparse.count * itemSizeIndices,
    );
    const sparseValues = new TypedArray(
      bufferViews[2],
      byteOffsetValues,
      accessorDef.sparse.count * itemSize,
    );

    if (bufferView !== null) {
      // Avoid modifying the original ArrayBuffer, if the bufferView wasn't initialized with zeroes.
      bufferAttribute = new THREE.BufferAttribute(
        bufferAttribute.array.slice(),
        bufferAttribute.itemSize,
        bufferAttribute.normalized,
      );
    }

    for (let i = 0, il = sparseIndices.length; i < il; i++) {
      const index = sparseIndices[i];
      bufferAttribute.setX(index, sparseValues[i * itemSize]);
      if (itemSize >= 2) bufferAttribute.setY(index, sparseValues[i * itemSize + 1]);
      if (itemSize >= 3) bufferAttribute.setZ(index, sparseValues[i * itemSize + 2]);
      if (itemSize >= 4) bufferAttribute.setW(index, sparseValues[i * itemSize + 3]);
      if (itemSize >= 5)
        throw new Error('GLTF Parser: Unsupported itemSize in sparse BufferAttribute.');
    }
  }

  return bufferAttribute;
}

function addPrimitiveAttributes(parser_data, geometry, primitiveDef) {
  const attributes = primitiveDef.attributes;

  for (const gltfAttributeName in attributes) {
    const threeAttributeName = ATTRIBUTES[gltfAttributeName] || gltfAttributeName.toLowerCase();
    // Skip attributes already provided by e.g. Draco extension.
    if (threeAttributeName in geometry.attributes) continue;
    geometry.setAttribute(threeAttributeName, parser_data.accessors[attributes[gltfAttributeName]]);
  }

  if (primitiveDef.indices !== undefined && !geometry.index) {
    geometry.setIndex(parser_data.accessors[primitiveDef.indices]);
  }

  assignExtrasToUserData(geometry, primitiveDef);
  computeBounds(parser_data, geometry, primitiveDef);

  // geometry.computeVertexNormals();

  return geometry;
}

function assignExtrasToUserData(object, gltfDef) {
  if (gltfDef.extras !== undefined) {
    if (typeof gltfDef.extras === 'object') {
      Object.assign(object.userData, gltfDef.extras);
    } else {
      console.warn('GLTF Parser: Ignoring primitive type .extras, ' + gltfDef.extras);
    }
  }
}

function computeBounds(parser_data, geometry, primitiveDef) {
  const attributes = primitiveDef.attributes;

  const box = new THREE.Box3();

  if (attributes.POSITION !== undefined) {
    const accessor = parser_data.gltf.accessors[attributes.POSITION];

    const min = accessor.min;
    const max = accessor.max;

    // glTF requires 'min' and 'max', but VRM (which extends glTF) currently ignores that requirement.

    if (min !== undefined && max !== undefined) {
      box.set(new THREE.Vector3(min[0], min[1], min[2]), new THREE.Vector3(max[0], max[1], max[2]));

      if (accessor.normalized) {
        const boxScale = getNormalizedComponentScale(WEBGL_COMPONENT_TYPES[accessor.componentType]);
        box.min.multiplyScalar(boxScale);
        box.max.multiplyScalar(boxScale);
      }
    } else {
      console.warn('GLTF Parser: Missing min/max properties for accessor POSITION.');

      return;
    }
  } else {
    return;
  }

  const targets = primitiveDef.targets;

  if (targets !== undefined) {
    const maxDisplacement = new THREE.Vector3();
    const vector = new THREE.Vector3();

    for (let i = 0, il = targets.length; i < il; i++) {
      const target = targets[i];

      if (target.POSITION !== undefined) {
        const accessor = parser_data.gltf.accessors[target.POSITION];
        const min = accessor.min;
        const max = accessor.max;

        // glTF requires 'min' and 'max', but VRM (which extends glTF) currently ignores that requirement.

        if (min !== undefined && max !== undefined) {
          // we need to get max of absolute components because target weight is [-1,1]
          vector.setX(Math.max(Math.abs(min[0]), Math.abs(max[0])));
          vector.setY(Math.max(Math.abs(min[1]), Math.abs(max[1])));
          vector.setZ(Math.max(Math.abs(min[2]), Math.abs(max[2])));

          if (accessor.normalized) {
            const boxScale = getNormalizedComponentScale(
              WEBGL_COMPONENT_TYPES[accessor.componentType],
            );
            vector.multiplyScalar(boxScale);
          }

          // Note: this assumes that the sum of all weights is at most 1. This isn't quite correct - it's more conservative
          // to assume that each target can have a max weight of 1. However, for some use cases - notably, when morph targets
          // are used to implement key-frame animations and as such only two are active at a time - this results in very large
          // boxes. So for now we make a box that's sometimes a touch too small but is hopefully mostly of reasonable size.
          maxDisplacement.max(vector);
        } else {
          console.warn('GLTF Parser: Missing min/max properties for accessor POSITION.');
        }
      }
    }

    // As per comment above this box isn't conservative, but has a reasonable size for a very large number of morph targets.
    box.expandByVector(maxDisplacement);
  }

  geometry.boundingBox = box;

  const sphere = new THREE.Sphere();

  box.getCenter(sphere.center);
  sphere.radius = box.min.distanceTo(box.max) / 2;

  geometry.boundingSphere = sphere;
}

function parseMaterial(parser_data, material_data) {
  // Parse based on THREE.js GLTFLoader
  // https://github.com/mrdoob/three.js/blob/a2e9ee8204b67f9dca79f48cf620a34a05aa8126/examples/jsm/loaders/GLTFLoader.js

  const materialParams = {};
  const metallicRoughness = material_data.pbrMetallicRoughness || {};
  materialParams.color = new THREE.Color(1.0, 1.0, 1.0);
  materialParams.opacity = 1.0;
  if (Array.isArray(metallicRoughness.baseColorFactor)) {
    const array = metallicRoughness.baseColorFactor;

    materialParams.color.setRGB(array[0], array[1], array[2], THREE.LinearSRGBColorSpace);
    materialParams.opacity = array[3];
  }
  materialParams.metalness =
    metallicRoughness.metallicFactor !== undefined ? metallicRoughness.metallicFactor : 1.0;
  materialParams.roughness =
    metallicRoughness.roughnessFactor !== undefined ? metallicRoughness.roughnessFactor : 1.0;
  if (material_data.doubleSided === true) {
    materialParams.side = THREE.DoubleSide;
  }

  const alphaMode = material_data.alphaMode || ALPHA_MODES.OPAQUE;

  if (alphaMode === ALPHA_MODES.BLEND) {
    materialParams.transparent = true;
    // See: https://github.com/mrdoob/three.js/issues/17706
    materialParams.depthWrite = false;
  } else {
    materialParams.transparent = false;
    if (alphaMode === ALPHA_MODES.MASK) {
      materialParams.alphaTest =
        material_data.alphaCutoff !== undefined ? material_data.alphaCutoff : 0.5;
    }
  }

  // var material = new THREE.MeshPhysicalMaterial();
  var material = new THREE.MeshStandardMaterial();
  // var material = new THREE.MeshNormalMaterial();
  // var material = new THREE.MeshBasicMaterial();
  material.setValues(materialParams);
  material.name = material_data.name;
  material.flatShading = true;
  material.roughness = 0.9;
  material.metallness = 0.1;
  // material.color.convertSRGBToLinear();

  // Have to make it double sided for now.
  // I think the problem is with some negative scale operations (flipping) that maybe revert the order of the points and cause the inversion
  material.side = THREE.DoubleSide;
  return material;
}
