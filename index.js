'use strict';

var Service, Characteristic, Accessory;
const exec = require("child_process").exec;

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    Accessory = homebridge.hap.Accessory;
    homebridge.registerAccessory('homebridge-samsung-airconditioner', 'SamsungAirconditioner', SamsungAirco);
}

class SamsungAirco {
    constructor(log, config) {
        this.log = log;
        this.name = config.name;
        this.ip = config.ip;
        this.token = config.token;
        this.patchCert = config.patchCert;
        this.deviceIndex = config.deviceIndex || 0; // config.json에서 기기 인덱스 설정 가능

        // --- 상태 캐싱을 위한 변수 ---
        this.cache = null;
        this.lastCacheTime = 0;
        this.cacheDuration = 2000; // 2초 캐시 유지

        this.baseUrl = `https://${this.ip}:8888/devices`;

        // 서비스 설정
        this.aircoSamsung = new Service.HeaterCooler(this.name);
        this.informationService = new Service.AccessoryInformation()
            .setCharacteristic(Characteristic.Manufacturer, 'Samsung')
            .setCharacteristic(Characteristic.Model, 'Air conditioner')
            .setCharacteristic(Characteristic.SerialNumber, 'AF16K7970WFN');
    }

    // --- 헬퍼 함수 (기존과 동일) ---
    execRequest(command) {
        return new Promise((resolve, reject) => {
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    this.log.error(`Command failed: ${command}`);
                    this.log.error(`stderr: ${stderr}`);
                    reject(error);
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    buildCurlCommand(endpoint, method = 'GET', data = null) {
        let command = `curl -s -k -H "Content-Type: application/json" -H "Authorization: Bearer ${this.token}" --cert "${this.patchCert}" --insecure -X ${method} ${this.baseUrl}${endpoint}`;
        if (data) {
            command += ` -d '${JSON.stringify(data)}'`;
        }
        return command;
    }

    // --- 캐싱 기능이 포함된 중앙 상태 조회 함수 ---
    async _getDeviceState() {
        const now = Date.now();
        if (this.cache && (now - this.lastCacheTime < this.cacheDuration)) {
            this.log.debug("Returning cached state");
            return this.cache;
        }

        this.log.info("Fetching new state from device...");
        // jq 필터를 통해 필요한 device 객체만 파싱
        const command = this.buildCurlCommand(` | jq '.Devices[${this.deviceIndex}]'`);
        
        try {
            const stdout = await this.execRequest(command);
            const state = JSON.parse(stdout);
            
            this.cache = state;
            this.lastCacheTime = now;
            
            return state;
        } catch (error) {
            this.log.error("Failed to parse device state. Returning last known state if available.");
            if (this.cache) {
                return this.cache; // 에러 발생 시 마지막으로 성공한 캐시 반환
            }
            throw new Error("Could not retrieve device state.");
        }
    }
    
    // --- `set` 명령어 실행 후 캐시 무효화 ---
    async _executeSetCommand(endpoint, data) {
        const command = this.buildCurlCommand(endpoint, 'PUT', data);
        await this.execRequest(command);
        this.log.info(`Successfully set state for ${endpoint}`);
        // 상태 변경 후 캐시를 즉시 무효화하여 다음 조회 시 새로운 값을 가져오도록 함
        this.cache = null;
    }

    identify(callback) {
        this.log("장치 확인됨");
        callback();
    }

    getServices() {
        // .on('get', ...) 대신 최신 Homebridge 방식인 .onGet(...) 사용
        this.aircoSamsung.getCharacteristic(Characteristic.Active)
            .onGet(this.getActive.bind(this))
            .onSet(this.setActive.bind(this));

        this.aircoSamsung.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({ minValue: 0, maxValue: 50, minStep: 1 })
            .onGet(this.getCurrentTemperature.bind(this));

        this.aircoSamsung.getCharacteristic(Characteristic.TargetHeaterCoolerState)
            .setProps({ validValues: [2] }) // COOL
            .onGet(this.getTargetHeaterCoolerState.bind(this))
            .onSet(this.setTargetHeaterCoolerState.bind(this));

        this.aircoSamsung.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
            .onGet(this.getCurrentHeaterCoolerState.bind(this));

        this.aircoSamsung.getCharacteristic(Characteristic.CoolingThresholdTemperature)
            .setProps({ minValue: 18, maxValue: 30, minStep: 1 })
            .onGet(this.getTargetTemperature.bind(this))
            .onSet(this.setTargetTemperature.bind(this));

        this.aircoSamsung.getCharacteristic(Characteristic.SwingMode)
            .onGet(this.getSwingMode.bind(this))
            .onSet(this.setSwingMode.bind(this));

        return [this.informationService, this.aircoSamsung];
    }

    // --- Getters and Setters (중앙 함수를 호출하도록 변경) ---

    async getActive() {
        const state = await this._getDeviceState();
        return state.Operation.power === "On" ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
    }

    async setActive(value) {
        const power = value === Characteristic.Active.ACTIVE ? "On" : "Off";
        await this._executeSetCommand('/0', { Operation: { power: power } });
    }

    async getCurrentTemperature() {
        const state = await this._getDeviceState();
        return state.Temperatures[0].current;
    }

    async getTargetTemperature() {
        const state = await this._getDeviceState();
        return state.Temperatures[0].desired;
    }

    async setTargetTemperature(value) {
        await this._executeSetCommand('/0/temperatures/0', { desired: value });
    }

    async getSwingMode() {
        const state = await this._getDeviceState();
        // 무풍 모드(Comode_Nano)를 스윙으로 매핑
        const mode = state.Mode.options.includes("Comode_Nano") ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED;
        return mode;
    }

    async setSwingMode(state) {
        const mode = state === Characteristic.SwingMode.SWING_ENABLED ? "Comode_Nano" : "Comode_Off";
        await this._executeSetCommand('/0/mode', { options: [mode] });
    }

    async getCurrentHeaterCoolerState() {
        const state = await this._getDeviceState();
        const coolModes = ["CoolClean", "Cool", "Dry", "DryClean", "Auto", "Wind"];
        return coolModes.includes(state.Mode.modes[0]) ? Characteristic.CurrentHeaterCoolerState.COOLING : Characteristic.CurrentHeaterCoolerState.IDLE;
    }

    async getTargetHeaterCoolerState() {
        const state = await this._getDeviceState();
        const coolModes = ["CoolClean", "Cool", "Dry", "DryClean", "Auto", "Wind"];
        return coolModes.includes(state.Mode.modes[0]) ? Characteristic.TargetHeaterCoolerState.COOL : Characteristic.TargetHeaterCoolerState.IDLE;
    }

    async setTargetHeaterCoolerState(state) {
        if (state === Characteristic.TargetHeaterCoolerState.COOL) {
            await this._executeSetCommand('/0/mode', { modes: ["Cool"] });
            this.aircoSamsung.getCharacteristic(Characteristic.CurrentHeaterCoolerState).updateValue(Characteristic.CurrentHeaterCoolerState.COOLING);
        }
    }
}
