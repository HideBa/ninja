import * as THREE from 'three';
import init, { HttpFcbReader, WasmSpatialQuery, cjseqToCj } from '@cityjson/flatcitybuf';
import { CityJSONLoader, CityJSONWorkerParser } from 'cityjson-threejs-loader';

/**
 * FlatCityBufLoader - Loads and manages FlatCityBuf data with dynamic spatial queries
 */
export class FlatCityBufLoader {
	constructor() {
		this.wasmInitialized = false;
		this.fcbReader = null;
		this.baseCityJSON = null;
		this.originalTransform = null;
		this.geographicalExtent = null;
		this.matrix = null;
		this.scene = new THREE.Scene();
		this.maxFeatures = 1000;
		this.loadedFeatures = [];

		// Helpers for visualization
		this.cameraFrustumHelper = null;
		this.extentHelper = null;
		this.geoExtentHelper = null;

		// Loading state
		this.isLoading = false;
		this.loadingCallbacks = {
			onLoadStart: null,
			onLoadEnd: null,
			onError: null
		};

		// Camera debounce
		this.cameraUpdateTimer = null;
		this.cameraUpdateDelay = 1000; // 1 second debounce
	}

	/**
	 * Initialize the WASM module
	 */
	async initWASM() {
		if (this.wasmInitialized) {
			return;
		}

		console.log('Initializing FlatCityBuf WASM module...');
		try {
			await init();
			this.wasmInitialized = true;
			console.log('FlatCityBuf WASM module initialized successfully');
		} catch (error) {
			console.error('Failed to initialize FlatCityBuf WASM:', error);
			throw error;
		}
	}

	/**
	 * Load FlatCityBuf from URL
	 */
	async load(url) {
		console.log('FlatCityBufUrl:', url);

		// Initialize WASM if not already done
		await this.initWASM();

		// Create HTTP reader
		try {
			this.fcbReader = new HttpFcbReader(url);
			console.log('HttpFcbReader created successfully');
		} catch (error) {
			console.error('Failed to create HttpFcbReader:', error);
			if (this.loadingCallbacks.onError) {
				this.loadingCallbacks.onError(error);
			}
			throw error;
		}

		// Get base CityJSON and metadata
		try {
			this.baseCityJSON = this.fcbReader.cityjson();
			const meta = this.fcbReader.meta();

			console.log('Base CityJSON:', this.baseCityJSON);
			console.log('Metadata:', meta);

			// Extract geographical extent from metadata
			if (meta && meta.geographical_extent) {
				this.geographicalExtent = meta.geographical_extent;
				console.log('Geographical extent:', this.geographicalExtent);
			}

			// Store original transform
			if (this.baseCityJSON && this.baseCityJSON.transform) {
				const t = this.baseCityJSON.transform;
				this.originalTransform = new THREE.Matrix4();
				this.originalTransform.set(
					t.scale[0], 0, 0, t.translate[0],
					0, t.scale[1], 0, t.translate[1],
					0, 0, t.scale[2], t.translate[2],
					0, 0, 0, 1
				);
				console.log('Original transform stored');
			}

		} catch (error) {
			console.error('Failed to get CityJSON or metadata:', error);
			if (this.loadingCallbacks.onError) {
				this.loadingCallbacks.onError(error);
			}
			throw error;
		}

		// Load initial data - 500m x 500m from center of extent
		if (this.geographicalExtent) {
			const [minX, minY, , maxX, maxY] = this.geographicalExtent;
			const centerX = (minX + maxX) / 2;
			const centerY = (minY + maxY) / 2;
			const bufferSize = 250; // 250m on each side = 500m total

			const initialBBox = {
				minX: centerX - bufferSize,
				minY: centerY - bufferSize,
				maxX: centerX + bufferSize,
				maxY: centerY + bufferSize
			};

			console.log('Loading initial 500m x 500m extent from center:', initialBBox);
			await this.loadSpatialData(initialBBox);
		}

		return this;
	}

	/**
	 * Load spatial data for a given bounding box
	 */
	async loadSpatialData(bbox) {
		if (!this.fcbReader) {
			console.error('FcbReader not initialized');
			return;
		}

		if (this.isLoading) {
			console.log('Already loading, skipping...');
			return;
		}

		this.isLoading = true;
		if (this.loadingCallbacks.onLoadStart) {
			this.loadingCallbacks.onLoadStart();
		}

		try {
			console.log('Querying spatial data with bbox:', bbox);

			// Create spatial query
			const spatialQuery = new WasmSpatialQuery({
				type: 'BoundingBox',
				minX: bbox.minX,
				minY: bbox.minY,
				maxX: bbox.maxX,
				maxY: bbox.maxY
			});

			// Execute spatial query with pagination
			const iter = await this.fcbReader.select_spatial_paged(
				spatialQuery,
				this.maxFeatures,
				null
			);

			// Read all features
			const features = [];
			let feature = await iter.next();
			while (feature !== undefined) {
				features.push(feature);
				feature = await iter.next();
			}

			console.log('features:', features);
			console.log('Feature count:', features.length);

			if (features.length === 0) {
				console.log('No features found in this area');
				this.isLoading = false;
				if (this.loadingCallbacks.onLoadEnd) {
					this.loadingCallbacks.onLoadEnd();
				}
				return;
			}

			// Convert to CityJSON
			const cityJSON = cjseqToCj(this.baseCityJSON, features);
			console.log('Converted CityJSON:', cityJSON);

			// Calculate bounding box for the features
			const featureBBox = this.calculateFeatureBBox(cityJSON);
			console.log('Bounding box:', featureBBox);

			// Clear previous scene objects
			this.clearSceneObjects();

			// Parse and render geometry
			await this.parseCityJSON(cityJSON, featureBBox);

			this.loadedFeatures = features;

		} catch (error) {
			console.error('Error loading spatial data:', error);
			if (this.loadingCallbacks.onError) {
				this.loadingCallbacks.onError(error);
			}
		} finally {
			this.isLoading = false;
			if (this.loadingCallbacks.onLoadEnd) {
				this.loadingCallbacks.onLoadEnd();
			}
		}
	}

	/**
	 * Calculate bounding box from CityJSON vertices
	 */
	calculateFeatureBBox(cityJSON) {
		if (!cityJSON || !cityJSON.vertices || cityJSON.vertices.length === 0) {
			return new THREE.Box3();
		}

		const bbox = new THREE.Box3();
		const transform = cityJSON.transform || { scale: [1, 1, 1], translate: [0, 0, 0] };

		for (const vertex of cityJSON.vertices) {
			const point = new THREE.Vector3(
				vertex[0] * transform.scale[0] + transform.translate[0],
				vertex[1] * transform.scale[1] + transform.translate[1],
				vertex[2] * transform.scale[2] + transform.translate[2]
			);
			bbox.expandByPoint(point);
		}

		return bbox;
	}

	/**
	 * Parse CityJSON and add to scene
	 */
	async parseCityJSON(cityJSON, bbox) {
		const parser = new CityJSONWorkerParser();
		parser.chunkSize = 2000;

		return new Promise((resolve) => {
			parser.onComplete = () => {
				console.log('Parsing complete');
				resolve();
			};

			const loader = new CityJSONLoader(parser);
			loader.load(cityJSON);

			// Store the transformation matrix
			this.matrix = loader.matrix.clone();

			// Add to scene
			this.scene.add(loader.scene);

			console.log('Data loaded and added to scene');
		});
	}

	/**
	 * Clear scene objects (except helpers)
	 */
	clearSceneObjects() {
		const objectsToRemove = [];

		this.scene.traverse((child) => {
			// Don't remove helper objects
			if (child !== this.cameraFrustumHelper &&
			    child !== this.extentHelper &&
			    child !== this.geoExtentHelper &&
			    child !== this.scene) {
				objectsToRemove.push(child);
			}
		});

		// Remove objects
		objectsToRemove.forEach((obj) => {
			if (obj.parent) {
				obj.parent.remove(obj);
			}

			// Dispose geometry and materials
			if (obj.geometry) {
				obj.geometry.dispose();
			}
			if (obj.material) {
				if (Array.isArray(obj.material)) {
					obj.material.forEach(mat => mat.dispose());
				} else {
					obj.material.dispose();
				}
			}
		});

		console.log('Scene objects cleared');
	}

	/**
	 * Setup camera movement observer
	 */
	setupCameraObserver(camera, controls, onUpdate) {
		if (!controls) {
			console.error('OrbitControls not provided');
			return;
		}

		// Listen to control changes
		const handleChange = () => {
			// Clear existing timer
			if (this.cameraUpdateTimer) {
				clearTimeout(this.cameraUpdateTimer);
			}

			// Set new timer
			this.cameraUpdateTimer = setTimeout(() => {
				console.log('Camera movement stopped, triggering data update');

				// Calculate camera-ground intersection
				const intersectionPoint = this.calculateCameraGroundIntersection(camera);

				if (intersectionPoint) {
					console.log('Camera-ground intersection:', intersectionPoint);

					// Create 500m bounding box around intersection
					const bbox = this.createBoundingBox(intersectionPoint, 250); // 250m radius

					// Transform to Dutch coordinates
					const dutchBBox = this.transformBBoxToDutchCoordinates(bbox);

					// Update extent helper visualization
					this.updateExtentHelper(intersectionPoint);

					// Update frustum helper
					this.updateFrustumHelper(camera, intersectionPoint);

					// Trigger callback
					if (onUpdate) {
						onUpdate(dutchBBox);
					}

					// Load new data
					this.loadSpatialData(dutchBBox);
				}
			}, this.cameraUpdateDelay);
		};

		// Attach event listener
		controls.addEventListener('change', handleChange);
		controls.addEventListener('end', handleChange);

		console.log('Camera observer setup complete');
	}

	/**
	 * Calculate intersection between camera view and ground plane
	 */
	calculateCameraGroundIntersection(camera) {
		// Create ray from camera in forward direction
		const direction = new THREE.Vector3(0, 0, -1);
		direction.applyQuaternion(camera.quaternion);
		direction.normalize();

		const ray = new THREE.Ray(camera.position, direction);

		// Create horizontal plane (XY plane in CityJSON coordinates, which is Z=constant in Three.js)
		// In Three.js, Y is up, so we use Y=0 as ground
		const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

		// Calculate intersection
		const intersectionPoint = new THREE.Vector3();
		const result = ray.intersectPlane(plane, intersectionPoint);

		if (result) {
			console.log('Ground intersection found at:', result);
			return result;
		}

		// If no intersection (camera looking up), use camera XZ position at Y=0
		console.log('No ground intersection, using camera XZ position');
		return new THREE.Vector3(camera.position.x, 0, camera.position.z);
	}

	/**
	 * Create bounding box around a center point
	 */
	createBoundingBox(center, radius) {
		return {
			minX: center.x - radius,
			minY: center.z - radius, // In Three.js, Z is used for the Y coordinate in CityJSON
			maxX: center.x + radius,
			maxY: center.z + radius
		};
	}

	/**
	 * Transform bounding box from Three.js coordinates to Dutch/original coordinates
	 */
	transformBBoxToDutchCoordinates(bbox) {
		if (!this.originalTransform) {
			console.warn('No original transform available, returning bbox as-is');
			return bbox;
		}

		// Create inverse transformation matrix
		const inverseTransform = this.originalTransform.clone().invert();

		// If there's a display matrix, we need to account for it too
		if (this.matrix) {
			const inverseDisplayMatrix = this.matrix.clone().invert();
			inverseTransform.multiply(inverseDisplayMatrix);
		}

		// Transform all four corners
		const corners = [
			new THREE.Vector3(bbox.minX, 0, bbox.minY),
			new THREE.Vector3(bbox.maxX, 0, bbox.minY),
			new THREE.Vector3(bbox.minX, 0, bbox.maxY),
			new THREE.Vector3(bbox.maxX, 0, bbox.maxY)
		];

		const transformedCorners = corners.map(corner =>
			corner.applyMatrix4(inverseTransform)
		);

		// Find min/max of transformed corners
		const dutchBBox = {
			minX: Math.min(...transformedCorners.map(c => c.x)),
			minY: Math.min(...transformedCorners.map(c => c.z)),
			maxX: Math.max(...transformedCorners.map(c => c.x)),
			maxY: Math.max(...transformedCorners.map(c => c.z))
		};

		console.log('Transformed bbox to Dutch coordinates:', dutchBBox);
		return dutchBBox;
	}

	/**
	 * Create visualization helper for camera frustum (red wireframe)
	 */
	createFrustumHelper(scene) {
		if (this.cameraFrustumHelper) {
			scene.remove(this.cameraFrustumHelper);
		}

		const geometry = new THREE.BoxGeometry(500, 10, 500);
		const material = new THREE.MeshBasicMaterial({
			color: 0xff0000,
			wireframe: true
		});

		this.cameraFrustumHelper = new THREE.Mesh(geometry, material);
		this.cameraFrustumHelper.position.y = 5;
		scene.add(this.cameraFrustumHelper);

		console.log('Camera frustum helper created (red)');
		return this.cameraFrustumHelper;
	}

	/**
	 * Update frustum helper position
	 */
	updateFrustumHelper(camera, intersectionPoint) {
		if (this.cameraFrustumHelper && intersectionPoint) {
			this.cameraFrustumHelper.position.copy(intersectionPoint);
			this.cameraFrustumHelper.position.y = 5;
		}
	}

	/**
	 * Create visualization helper for dynamic loading extent (blue wireframe)
	 */
	createExtentHelper(scene) {
		if (this.extentHelper) {
			scene.remove(this.extentHelper);
		}

		const geometry = new THREE.BoxGeometry(500, 10, 500);
		const material = new THREE.MeshBasicMaterial({
			color: 0x0066ff,
			wireframe: true,
			transparent: true,
			opacity: 0.6
		});

		this.extentHelper = new THREE.Mesh(geometry, material);
		this.extentHelper.position.y = 5;
		scene.add(this.extentHelper);

		console.log('Dynamic extent helper created (blue)');
		return this.extentHelper;
	}

	/**
	 * Update extent helper position
	 */
	updateExtentHelper(intersectionPoint) {
		if (this.extentHelper && intersectionPoint) {
			this.extentHelper.position.copy(intersectionPoint);
			this.extentHelper.position.y = 5;
		}
	}

	/**
	 * Create visualization helper for geographical extent (green wireframe)
	 */
	createGeoExtentHelper(scene) {
		if (!this.geographicalExtent) {
			console.warn('No geographical extent available');
			return null;
		}

		if (this.geoExtentHelper) {
			scene.remove(this.geoExtentHelper);
		}

		const [minX, minY, minZ, maxX, maxY, maxZ] = this.geographicalExtent;

		// Apply transformation to get Three.js coordinates
		const width = maxX - minX;
		const depth = maxY - minY;
		const height = maxZ - minZ;

		const geometry = new THREE.BoxGeometry(width, height, depth);
		const material = new THREE.MeshBasicMaterial({
			color: 0x00ff00,
			wireframe: true,
			transparent: true,
			opacity: 0.3
		});

		this.geoExtentHelper = new THREE.Mesh(geometry, material);

		// Position at center of extent
		const centerPos = new THREE.Vector3(
			(minX + maxX) / 2,
			(minZ + maxZ) / 2,
			(minY + maxY) / 2
		);

		// Apply transformation if available
		if (this.matrix) {
			centerPos.applyMatrix4(this.matrix);
		}

		this.geoExtentHelper.position.copy(centerPos);
		scene.add(this.geoExtentHelper);

		console.log('Geographical extent helper created (green)');
		return this.geoExtentHelper;
	}

	/**
	 * Dispose of all resources
	 */
	dispose() {
		this.clearSceneObjects();

		// Remove helpers
		if (this.cameraFrustumHelper) {
			this.cameraFrustumHelper.geometry.dispose();
			this.cameraFrustumHelper.material.dispose();
		}
		if (this.extentHelper) {
			this.extentHelper.geometry.dispose();
			this.extentHelper.material.dispose();
		}
		if (this.geoExtentHelper) {
			this.geoExtentHelper.geometry.dispose();
			this.geoExtentHelper.material.dispose();
		}

		// Clear timer
		if (this.cameraUpdateTimer) {
			clearTimeout(this.cameraUpdateTimer);
		}

		console.log('FlatCityBufLoader disposed');
	}
}
