'use strict';

const Executor = require('screwdriver-executor-base');
const Fusebox = require('circuit-fuses');
const fs = require('fs');
const hoek = require('hoek');
const path = require('path');
const randomstring = require('randomstring');
const requestretry = require('requestretry');
const tinytim = require('tinytim');
const yaml = require('js-yaml');
const _ = require('lodash');

const DEFAULT_BUILD_TIMEOUT = 90;   // 90 minutes
const MAX_BUILD_TIMEOUT = 120;       // 120 minutes
const MAXATTEMPTS = 5;
const RETRYDELAY = 3000;
const CPU_RESOURCE = 'beta.screwdriver.cd/cpu';
const RAM_RESOURCE = 'beta.screwdriver.cd/ram';
const ANNOTATION_BUILD_TIMEOUT = 'beta.screwdriver.cd/timeout';
const TOLERATIONS_PATH = 'spec.tolerations';
const AFFINITY_NODE_SELECTOR_PATH = 'spec.affinity.nodeAffinity.' +
    'requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms';
const AFFINITY_PREFERRED_NODE_SELECTOR_PATH = 'spec.affinity.nodeAffinity.' +
    'preferredDuringSchedulingIgnoredDuringExecution';
const PREFERRED_WEIGHT = 100;

/**
 * Parses nodeSelector config and update intended nodeSelector in tolerations
 * and nodeAffinity.
 * @method setNodeSelector
 * @param {Object} podConfig k8s pod config
 * @param {Object} nodeSelectors key-value pairs of node selectors
 */
function setNodeSelector(podConfig, nodeSelectors) {
    if (!nodeSelectors || typeof nodeSelectors !== 'object' || !Object.keys(nodeSelectors).length) {
        return;
    }

    const tolerations = _.get(podConfig, TOLERATIONS_PATH, []);
    const nodeAffinitySelectors = _.get(podConfig, AFFINITY_NODE_SELECTOR_PATH, []);

    Object.keys(nodeSelectors).forEach((key) => {
        tolerations.push({
            key,
            value: nodeSelectors[key],
            effect: 'NoSchedule',
            operator: 'Equal'
        });
        nodeAffinitySelectors.push({
            matchExpressions: [{
                key,
                operator: 'In',
                values: [nodeSelectors[key]]
            }]
        });
    });
    const tmpNodeAffinitySelector = {};

    _.set(podConfig, TOLERATIONS_PATH, tolerations);
    _.set(tmpNodeAffinitySelector, AFFINITY_NODE_SELECTOR_PATH, nodeAffinitySelectors);
    _.merge(podConfig, tmpNodeAffinitySelector);
}

/**
 * Parses preferredNodeSelector config and update intended preferredNodeSelector in nodeAffinity.
 * @param {Object} podConfig              k8s pod config
 * @param {Object} preferredNodeSelectors key-value pairs of preferred node selectors
 */
function setPreferredNodeSelector(podConfig, preferredNodeSelectors) {
    if (!preferredNodeSelectors || typeof preferredNodeSelectors !== 'object' ||
        !Object.keys(preferredNodeSelectors).length) {
        return;
    }

    const preferredNodeAffinitySelectors = [];
    const preferredNodeAffinityItem = {
        weight: PREFERRED_WEIGHT,
        preference: {}
    };
    const preferredNodeAffinity = _.get(podConfig, AFFINITY_PREFERRED_NODE_SELECTOR_PATH, []);

    Object.keys(preferredNodeSelectors).forEach((key) => {
        preferredNodeAffinitySelectors.push(
            {
                key,
                operator: 'In',
                values: [preferredNodeSelectors[key]]
            }
        );
    });

    preferredNodeAffinityItem.preference.matchExpressions = preferredNodeAffinitySelectors;
    preferredNodeAffinity.push(preferredNodeAffinityItem);

    const tmpPreferredNodeAffinitySelector = {};

    _.set(tmpPreferredNodeAffinitySelector,
        AFFINITY_PREFERRED_NODE_SELECTOR_PATH, preferredNodeAffinity);
    _.merge(podConfig, tmpPreferredNodeAffinitySelector);
}

class K8sVMExecutor extends Executor {
    /**
     * Constructor
     * @method constructor
     * @param  {Object} options                                       Configuration options
     * @param  {Object} options.ecosystem                             Screwdriver Ecosystem
     * @param  {Object} options.ecosystem.api                         Routable URI to Screwdriver API
     * @param  {Object} [options.ecosystem.pushgatewayUrl]            Pushgateway URL for Prometheus
     * @param  {Object} options.ecosystem.store                       Routable URI to Screwdriver Store
     * @param  {Object} options.kubernetes                            Kubernetes configuration
     * @param  {String} [options.kubernetes.token]                    API Token (loaded from /var/run/secrets/kubernetes.io/serviceaccount/token if not provided)
     * @param  {String} [options.kubernetes.host=kubernetes.default]  Kubernetes hostname
     * @param  {String} [options.kubernetes.jobsNamespace=default]    Pods namespace for Screwdriver Jobs
     * @param  {String} [options.kubernetes.baseImage]                Base image for the pod
     * @param  {Number} [options.kubernetes.buildTimeout=90]          Number of minutes to allow a build to run before considering it is timed out
     * @param  {Number} [options.kubernetes.maxBuildTimeout=120]      Max timeout user can configure up to (in minutes)
     * @param  {String} [options.kubernetes.resources.cpu.high=6]     Value for HIGH CPU (in cores)
     * @param  {Number} [options.kubernetes.resources.cpu.low=2]      Value for LOW CPU (in cores)
     * @param  {Number} [options.kubernetes.resources.memory.high=12] Value for HIGH memory (in GB)
     * @param  {Number} [options.kubernetes.resources.memory.low=2]   Value for LOW memory (in GB)
     * @param  {Number} [options.kubernetes.jobsNamespace=default]    Pods namespace for Screwdriver Jobs
     * @param  {Object} [options.kubernetes.nodeSelectors]            Object representing node label-value pairs
     * @param  {String} [options.launchVersion=stable]                Launcher container version to use
     * @param  {String} [options.prefix='']                           Prefix for job name
     * @param  {String} [options.fusebox]                             Options for the circuit breaker (https://github.com/screwdriver-cd/circuit-fuses)
     */
    constructor(options = {}) {
        super();

        this.kubernetes = options.kubernetes || {};
        this.ecosystem = options.ecosystem;

        if (this.kubernetes.token) {
            this.token = this.kubernetes.token;
        } else {
            const filepath = '/var/run/secrets/kubernetes.io/serviceaccount/token';

            this.token = fs.existsSync(filepath) ? fs.readFileSync(filepath) : '';
        }
        this.host = this.kubernetes.host || 'kubernetes.default';
        this.launchVersion = options.launchVersion || 'stable';
        this.prefix = options.prefix || '';
        this.jobsNamespace = this.kubernetes.jobsNamespace || 'default';
        this.baseImage = this.kubernetes.baseImage;
        this.buildTimeout = this.kubernetes.buildTimeout || DEFAULT_BUILD_TIMEOUT;
        this.maxBuildTimeout = this.kubernetes.maxBuildTimeout || MAX_BUILD_TIMEOUT;
        this.podsUrl = `https://${this.host}/api/v1/namespaces/${this.jobsNamespace}/pods`;
        this.breaker = new Fusebox(requestretry, options.fusebox);
        this.highCpu = hoek.reach(options, 'kubernetes.resources.cpu.high', { default: 6 });
        this.lowCpu = hoek.reach(options, 'kubernetes.resources.cpu.low', { default: 2 });
        this.highMemory = hoek.reach(options, 'kubernetes.resources.memory.high', { default: 12 });
        this.lowMemory = hoek.reach(options, 'kubernetes.resources.memory.low', { default: 2 });
        this.podRetryStrategy = (err, response, body) => {
            const status = hoek.reach(body, 'status.phase');

            return err || !status || status.toLowerCase() === 'pending';
        };

        this.nodeSelectors = hoek.reach(options, 'kubernetes.nodeSelectors');
        this.preferredNodeSelectors = hoek.reach(options, 'kubernetes.preferredNodeSelectors');
    }

    /**
     * Starts a k8s build
     * @method start
     * @param  {Object}   config                A configuration object
     * @param  {Object}   [config.annotations]  Set of key value pairs
     * @param  {Integer}  config.buildId        ID for the build
     * @param  {String}   config.container      Container for the build to run in
     * @param  {String}   config.token          JWT for the Build
     * @return {Promise}
     */
    _start(config) {
        const annotations = hoek.reach(config, 'annotations', { default: {} });
        const cpuConfig = hoek.reach(config, 'annotations', { default: {} })[CPU_RESOURCE];
        const ramConfig = hoek.reach(config, 'annotations', { default: {} })[RAM_RESOURCE];
        const CPU = (cpuConfig === 'HIGH') ? this.highCpu : this.lowCpu;
        const MEMORY = (ramConfig === 'HIGH') ? this.highMemory * 1024 : this.lowMemory * 1024;   // 12GB or 2GB
        const random = randomstring.generate({
            length: 5,
            charset: 'alphanumeric',
            capitalization: 'lowercase'
        });
        const buildTimeout = annotations[ANNOTATION_BUILD_TIMEOUT]
            ? Math.min(annotations[ANNOTATION_BUILD_TIMEOUT], this.maxBuildTimeout)
            : this.buildTimeout;
        const podTemplate = tinytim.renderFile(path.resolve(__dirname, './config/pod.yaml.tim'), {
            cpu: CPU,
            memory: MEMORY,
            pod_name: `${this.prefix}${config.buildId}-${random}`,
            build_id_with_prefix: `${this.prefix}${config.buildId}`,
            build_id: config.buildId,
            build_timeout: buildTimeout,
            container: config.container,
            api_uri: this.ecosystem.api,
            store_uri: this.ecosystem.store,
            pushgateway_url: hoek.reach(this.ecosystem, 'pushgatewayUrl', { default: '' }),
            token: config.token,
            launcher_version: this.launchVersion,
            base_image: this.baseImage
        });

        const podConfig = yaml.safeLoad(podTemplate);

        setNodeSelector(podConfig, this.nodeSelectors);
        setPreferredNodeSelector(podConfig, this.preferredNodeSelectors);

        const options = {
            uri: this.podsUrl,
            method: 'POST',
            body: podConfig,
            headers: { Authorization: `Bearer ${this.token}` },
            strictSSL: false,
            json: true
        };

        return this.breaker.runCommand(options)
            .then((resp) => {
                if (resp.statusCode !== 201) {
                    throw new Error(`Failed to create pod: ${JSON.stringify(resp.body)}`);
                }

                return resp.body.metadata.name;
            })
            .then((podname) => {
                const statusOptions = {
                    uri: `${this.podsUrl}/${podname}/status`,
                    method: 'GET',
                    headers: { Authorization: `Bearer ${this.token}` },
                    strictSSL: false,
                    maxAttempts: MAXATTEMPTS,
                    retryDelay: RETRYDELAY,
                    retryStrategy: this.podRetryStrategy,
                    json: true
                };

                return this.breaker.runCommand(statusOptions);
            })
            .then((resp) => {
                if (resp.statusCode !== 200) {
                    throw new Error(`Failed to get pod status:
                        ${JSON.stringify(resp.body, null, 2)}`);
                }

                const status = resp.body.status.phase.toLowerCase();

                if (status === 'failed' || status === 'unknown') {
                    throw new Error(`Failed to create pod. Pod status is:
                        ${JSON.stringify(resp.body.status, null, 2)}`);
                }

                return null;
            });
    }

    /**
     * Stop a k8s build
     * @method stop
     * @param  {Object}   config            A configuration object
     * @param  {Integer}  config.buildId    ID for the build
     * @return {Promise}
     */
    _stop(config) {
        const options = {
            uri: this.podsUrl,
            method: 'DELETE',
            qs: {
                labelSelector: `sdbuild=${this.prefix}${config.buildId}`
            },
            headers: {
                Authorization: `Bearer ${this.token}`
            },
            strictSSL: false
        };

        return this.breaker.runCommand(options)
            .then((resp) => {
                if (resp.statusCode !== 200) {
                    throw new Error(`Failed to delete pod: ${JSON.stringify(resp.body)}`);
                }

                return null;
            });
    }

    /**
    * Retreive stats for the executor
    * @method stats
    * @param  {Response} Object          Object containing stats for the executor
    */
    stats() {
        return this.breaker.stats();
    }
}

module.exports = K8sVMExecutor;
