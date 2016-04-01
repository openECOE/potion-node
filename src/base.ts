import 'core-js/shim';
import 'reflect-metadata';
import {fromCamelCase} from './utils';


export interface PotionCache<T extends Item> {
	get(id: string): T;
	set(id: string, item: T): T;
	clear(id: string): void;
}


const _potionMetadataKey = Symbol('potion');
const _potionUriMetadataKey = Symbol('potion:uri');


/**
 * @readonly decorator
 */

const _readonlyMetadataKey = Symbol('potion:readonly');
export function readonly(target, property) {
	const metadata = Reflect.getMetadata(_readonlyMetadataKey, target.constructor);
	Reflect.defineMetadata(_readonlyMetadataKey, Object.assign(metadata || {}, {[property]: true}), target.constructor);
}


export interface ItemConstructor {
	store?: Store<Item>;
	new (object: any): Item;
}

export interface ItemOptions {
	'readonly': string[];
}

export class Item {
	static store: Store<any>;

	get uri() {
		return this._uri;
	}

	set uri(uri) {
		this._uri = uri;
	}

	get id() {
		if (!this.uri) {
			return null;
		}

		const {params} = this._potion.parseURI(this.uri);
		return parseInt(params[0], 10);
	}

	protected _uri: string;
	protected _potion: PotionBase;
	protected _rootUri: string;

	static fetch(id, options?: PotionFetchOptions): Promise<Item> {
		return this.store.fetch(id, options);
	}

	static query(options?: PotionFetchOptions): Promise<Item[]> {
		return this.store.query(options);
	}

	static create(...args) {
		return Reflect.construct(this, args);
	}

	constructor(properties: any = {}, options?: ItemOptions) {
		Object.assign(this, properties);
		this._potion = <PotionBase>Reflect.getMetadata(_potionMetadataKey, this.constructor);
		this._rootUri = Reflect.getMetadata(_potionUriMetadataKey, this.constructor);

		if (options && Array.isArray(options.readonly)) {
			options.readonly.forEach((property) => readonly(this, property));
		}
	}

	update(properties: any = {}): Promise<Item> {
		return this._potion.update(this, properties);
	}

	save(): Promise<Item> {
		return this._potion.save(this._rootUri, this.toJSON());
	}

	destroy(): Promise<Item> {
		return this._potion.destroy(this);
	}

	toJSON() {
		const properties = {};

		Object.keys(this)
			.filter((key) => {
				const metadata = Reflect.getMetadata(_readonlyMetadataKey, this.constructor);
				return key !== '_uri' && key !== '_potion' && key !== '_rootUri' && (!metadata || (metadata && !metadata[key]));
			})
			.forEach((key) => {
				properties[fromCamelCase(key)] = this[key];
			});

		return properties;
	}
}


export interface PotionEndpoint {
	resource: Item;
	params: string[];
	uri: string;
}

export interface PotionOptions {
	prefix?: string;
	cache?: PotionCache<Item>;
}

export interface PotionFetchOptions {
	cache?: any;
	method?: 'GET' | 'PUT' | 'DELETE' | 'POST';
	data?: any;
}

export abstract class PotionBase {
	resources = {};
	cache: PotionCache<Item>;

	private _prefix: string;
	private _promises = [];

	static create() {
		return Reflect.construct(this, arguments);
	}

	constructor({prefix = '', cache}: PotionOptions = {}) {
		this._prefix = prefix;
		this.cache = cache;
	}

	parseURI(uri: string): PotionEndpoint {
		uri = decodeURIComponent(uri);

		if (uri.indexOf(this._prefix) === 0) {
			uri = uri.substring(this._prefix.length);
		}

		for (let [resourceURI] of (<any>Object).entries(this.resources)) {
			if (uri.indexOf(`${resourceURI}/`) === 0) {
				return {uri, resource: this.resources[resourceURI], params: uri.substring(resourceURI.length + 1).split('/')};
			}
		}

		throw new Error(`Uninterpretable or unknown resource URI: ${uri}`);
	}

	abstract fetch(uri, options?: PotionFetchOptions): Promise<any>;
	abstract fromPotionJSON(json: any): Promise<any>;

	request(uri, options?: PotionFetchOptions): Promise<any> {
		// Add the API prefix if not present
		if (uri.indexOf(this._prefix) === -1) {
			uri = `${this._prefix}${uri}`;
		}

		return this.fetch(uri, options);
	}

	get(uri, options?: PotionFetchOptions): Promise<any> {
		// Try to get from cache
		if (this.cache && this.cache.get) {
			const instance = this.cache.get(uri);
			if (instance) {
				return Promise.resolve(instance);
			}
		}

		// If we already asked for the resource,
		// return the exiting promise.
		let promise = this._promises[uri];
		if (promise) {
			return promise;
		}

		// Register a pending request,
		// get the data,
		// and parse it.
		// Enforce GET method
		promise = this._promises[uri] = this.request(uri, Object.assign({}, options, {method: 'GET'})).then((json) => {
			delete this._promises[uri]; // Remove pending request
			return this.fromPotionJSON(json);
		});

		return promise;
	}

	update(item: Item, data: any = {}): Promise<any> {
		return this.request(item.uri, {data, method: 'PUT'}).then((json) => this.fromPotionJSON(json));
	}

	save(rootUri: string, data: any = {}): Promise<any> {
		return this.request(rootUri, {data, method: 'POST'}).then((json) => this.fromPotionJSON(json));
	}

	destroy(item: Item): Promise<any> {
		const {uri} = item;

		return this.request(uri, {method: 'DELETE'}).then(() => {
			// Clear the item from cache if exists
			if (this.cache && this.cache.get && this.cache.get(uri)) {
				this.cache.clear(uri);
			}
		});
	}

	register(uri: string, resource: ItemConstructor) {
		Reflect.defineMetadata(_potionMetadataKey, this, resource);
		Reflect.defineMetadata(_potionUriMetadataKey, uri, resource);
		this.resources[uri] = resource;
		resource.store = new Store(resource);
	}

	registerAs(uri: string): ClassDecorator {
		return (target: any) => {
			this.register(uri, target);
			return target;
		};
	}

}


export class Store<T extends Item> {
	private _potion: PotionBase;
	private _rootURI: string;

	constructor(ctor: ItemConstructor) {
		this._potion = Reflect.getMetadata(_potionMetadataKey, ctor);
		this._rootURI = Reflect.getMetadata(_potionUriMetadataKey, ctor);
	}

	fetch(id: number, options?: PotionFetchOptions): Promise<T> {
		return this._potion.get(`${this._rootURI}/${id}`, options);
	}

	query(options?: PotionFetchOptions): Promise<T> {
		return this._potion.get(this._rootURI, options);
	}
}


export function route(uri: string, {method = 'GET'}: PotionFetchOptions = {}): (options?) => Promise<any> {
	return function (options?: PotionFetchOptions) {
		let potion: PotionBase;

		if (typeof this === 'function') {
			potion = <PotionBase>Reflect.getMetadata(_potionMetadataKey, this);
			uri = `${Reflect.getMetadata(_potionUriMetadataKey, this)}${uri}`;
		} else {
			potion = <PotionBase>Reflect.getMetadata(_potionMetadataKey, this.constructor);
			uri = `${this.uri}${uri}`;
		}

		return potion.get(uri, Object.assign({method}, options));
	};
}

export class Route {
	static GET(uri: string): (options?) => Promise<any> {
		return route(uri, {method: 'GET'});
	}

	static DELETE(uri: string): (options?) => Promise<any> {
		return route(uri, {method: 'DELETE'});
	}

	static POST(uri: string): (options?) => Promise<any> {
		return route(uri, {method: 'POST'});
	}

	static PUT(uri: string): (options?) => Promise<any> {
		return route(uri, {method: 'PUT'});
	}
}