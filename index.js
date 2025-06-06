'use strict';

const axios = require('axios');
const https = require('https');
const fs = require('fs');
const { exec } = require('child_process'); // For certificate reading if needed

var Service, Characteristic, Accessory;

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
        
        // --- 설정 강화 ---
        this.ip = config.ip;
        this.token = config.token;
        this.patchCert = config.patchCert;
        this.deviceIndex = config.deviceIndex || 0; // 설정에서 기기 인덱스 지정 가능 (기본값 0)
        this.cacheDuration = config.cacheDuration || 3000; // 3초 캐시

        if (!this.ip || !this.token || !this.patchCert) {
            this.log.error("IP, token, and patchCert must be configured.");
            return;
        }

        // --- Axios 인스턴스 생성 (성능 및 안정성 향상) ---
        // 매번 curl을 실행하는 대신, 재사용 가능한 HTTP 클라이언트 생성
        this.api = axios.create({
            baseURL: `https://${this.ip}:8888`,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.token}`
            },
            httpsAgent: new https.Agent({
                cert: fs.readFileSync(this.patchCert),
                rejectUnauthorized: false // 자체 서명 인증서 허용
            }),
            timeout: 5000 // 5초 타임아웃
        });

        // --- 상태 캐싱 (API 요청 최소화) ---
        this.deviceState = null;
        this.lastStateUpdate = 0;

        this.aircoSamsung = new Service.HeaterCooler(this.name);
        this.informationService = new Service.AccessoryInformation()
            .setCharacteristic(Characteristic.Manufacturer, 'Samsung')
            .setCharacteristic(Characteristic.Model, 'Air Conditioner')
            .setCharacteristic(Characteristic.SerialNumber, config.serialNumber || 'DefaultSN');
    }

    // --- 상태 캐싱을 위한 헬퍼 함수 ---
    async getCachedState() {
        const now = Date.now();
        if (this.deviceState && (now - this.lastStateUpdate < this.cacheDuration)) {
            // 캐시가 유효하면 기존 상태 반환
            return this.deviceState;
        }

        this.log.info('Fetching latest state from device...');
        try {
            const response = await this.api.get('/devices');
            // 장치 인덱스를 사용하여 특정 장치의 상태를 저장
            this.deviceState = response.data.Devices[this.deviceIndex];
            this.lastStateUpdate = now;
            return this.deviceState;
        } catch (error) {
            this.log.error(`Failed to fetch device state: ${error.message}`);
            // 에러 발생 시 캐시된 오래된 데이터라도 반환하거나 에러 throw
            if (this.deviceState) {
                this.log.warn('Returning stale data due to fetch error.');
                return this.deviceState;
            }
            throw new Error('Could not fetch device state.');
        }
    }

    // --- API 제어 헬퍼 함수 ---
    async sendCommand(endpoint, data) {
        try {
            await this.api.put(endpoint, data);
            // 성공적으로 명령을 보낸 후 즉시 상태를 업데이트하여 UI에 빠르게 반영
            this.deviceState = null; // 캐시 무효화
            await this.getCachedState();
        } catch (error) {
            this.log.error(`Failed to send command to ${endpoint}: ${error.message}`);
            throw error; // 에러를 상위로 전달하여 HomeKit에 알림
        }
    }

    identify(callback) {
        this.log.info("Identify requested!");
        callback();
    }

    getServices() {
        this.aircoSamsung.getCharacteristic(Characteristic.Active)
            .onGet(this.getActive.bind(this))
            .onSet(this.setActive.bind(this));

        this.aircoSamsung.getCharacteristic(Characteristic.CurrentTemperature)
            .onGet(this.getCurrentTemperature.bind(this));

        this.aircoSamsung.getCharacteristic(Characteristic.TargetHeaterCoolerState)
            .setProps({ validValues: [Characteristic.TargetHeaterCoolerState.COOL] })
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
    
    // --- Getters & Setters (캐시된 데이터 사용으로 매우 빨라짐) ---
    
    async getActive() {
        const state = await this.getCachedState();
        const isActive = state.Operation.power === "On" ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
        this.log.debug('Get Active:', isActive);
        return isActive;
    }

    async setActive(value) {
        this.log.info('Set Active to:', value);
        const power = value === Characteristic.Active.ACTIVE ? "On" : "Off";
        await this.sendCommand('/devices/0', { Operation: { power: power } });
    }

    async getCurrentTemperature() {
        const state = await this.getCachedState();
        const temp = state.Temperatures[0].current;
        this.log.debug('Get CurrentTemperature:', temp);
        return temp;
    }

    async getTargetTemperature() {
        const state = await this.getCachedState();
        const temp = state.Temperatures[0].desired;
        this.log.debug('Get TargetTemperature:', temp);
        return temp;
    }

    async setTargetTemperature(value) {
        this.log.info('Set TargetTemperature to:', value);
        await this.sendCommand('/devices/0/temperatures/0', { desired: value });
    }

    async getSwingMode() {
        const state = await this.getCachedState();
        // 무풍 모드(Comode_Nano)를 스윙으로 매핑
        const mode = state.Mode.options.includes("Comode_Nano") ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED;
        this.log.debug('Get SwingMode:', mode);
        return mode;
    }

    async setSwingMode(value) {
        this.log.info('Set SwingMode to:', value);
        const mode = value === Characteristic.SwingMode.SWING_ENABLED ? "Comode_Nano" : "Comode_Off";
        // 현재 모드 배열을 유지하며 options만 변경 (가정)
        const currentState = await this.getCachedState();
        const currentModes = currentState.Mode.modes;
        await this.sendCommand('/devices/0/mode', { modes: currentModes, options: [mode] });
    }

    async getCurrentHeaterCoolerState() {
        const state = await this.getCachedState();
        const coolModes = ["CoolClean", "Cool", "Dry", "DryClean", "Auto", "Wind"];
        const isCooling = coolModes.includes(state.Mode.modes[0]);
        const currentState = isCooling ? Characteristic.CurrentHeaterCoolerState.COOLING : Characteristic.CurrentHeaterCoolerState.IDLE;
        this.log.debug('Get CurrentHeaterCoolerState:', currentState);
        return currentState;
    }

    async getTargetHeaterCoolerState() {
        // 이 로직은 현재 상태와 동일하게 동작하도록 유지
        return this.getCurrentHeaterCoolerState();
    }
    
    async setTargetHeaterCoolerState(value) {
        this.log.info('Set TargetHeaterCoolerState to:', value);
        if (value === Characteristic.TargetHeaterCoolerState.COOL) {
            // 가장 일반적인 '냉방' 모드로 설정
            await this.sendCommand('/devices/0/mode', { modes: ["Cool"] });
            // 상태 즉시 업데이트
            this.aircoSamsung.getCharacteristic(Characteristic.CurrentHeaterCoolerState).updateValue(Characteristic.CurrentHeaterCoolerState.COOLING);
        }
        // OFF나 HEAT 상태는 지원하지 않으므로 별도 처리 없음
    }
}
