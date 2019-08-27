/*

	Node.js driver for BME280 sensor
	Andrew Shmelev (c) 2019

*/

exports.plugin = function() {

	const async = require('async');
	const i2c = require('i2c-bus');

// I2C Address
	const BME280_ADDR		=	0x76; 	// or 0x77 same as bmp280

// Registers addresses
	const BME280_DATA		=	0xF7;	//8 bytes for data
	const BME280_CONFIG		=	0xF5;
	const BME280_CTRL_MEAS	=	0xF4;
	const BME280_STATUS		=	0xF3;
	const BME280_CTRL_HUM	=	0xF2;
	const BME280_HW_ID		=	0xD0;
	const BME280_RESET  	= 	0xE0;

//Config parameters

	const BME280_MODE_SLEEP		=	0b00;
	const BME280_MODE_FORCED	=	0b01;
	const BME280_MODE_NORMAL	=	0b11;

	const BME280_MEAS_OVERSAMPLING	=	{
		0: 0b000,
		1: 0b001,
		2: 0b010,
		4: 0b011,
		8: 0b100,
		16: 0b101
	}

	class Mutex {
		constructor () {
			this.queue = [];
			this.locked = false;
		}

		lock () {
			return new Promise((resolve, reject) => {
				if (this.locked) {
					this.queue.push([resolve, reject]);
				} else {
					this.locked = true;
					resolve();
				}
			});
		}

		release () {
			if (this.queue.length > 0) {
				const [resolve, reject] = this.queue.shift();
				resolve();
			} else {
				this.locked = false;
			}
		}
	}

	class bme280 {

		constructor() {

			//Set oversampling for measurement:
			const ovrs_p = 8;
			const ovrs_t = 8;
			const ovrs_h = 8;

			const osrs_p = BME280_MEAS_OVERSAMPLING[ovrs_p];		//pressure
			const osrs_t = BME280_MEAS_OVERSAMPLING[ovrs_t];		//temperature
			const osrs_h = BME280_MEAS_OVERSAMPLING[ovrs_h];		//humidity

			this.ctrl_meas = (osrs_t << 5) + (osrs_p << 2) + BME280_MODE_NORMAL;
			this.ctrl_hum = osrs_h;

			this.meas_time = 1.25 + (2.3 * ovrs_t);
			if(ovrs_p) this.meas_time = this.meas_time + (2.3 * ovrs_p + 0.575);
			if(ovrs_h) this.meas_time = this.meas_time + (2.3 * ovrs_h + 0.575);

// 			console.log(this.ctrl_meas.toString(2));

			this.sensor_fault = false;

			this.mutex = new Mutex();

			this._logfunc = (...args) => { process.stdout.write(args.join(" ")); }
			this._logprefix = 'BME280:';
			this._logstr = '';
			this.log = (...args) => {
				if(this._logstr === "") this._logfunc("\x1b[31m\x1b[1m" + this._logprefix + "\x1b[0m ");
				this._logfunc(args.join(" ").trim() + "\n");
				this._logstr = "";
			}

			this.mutex.lock();
			this._initHardware()
		}

		async _initHardware() {
			try {
				await this._checkHWID();
				await this.writeSensor(BME280_CTRL_HUM, Buffer.from([this.ctrl_hum]), true);
				await this.writeSensor(BME280_CTRL_MEAS, Buffer.from([this.ctrl_meas]), true);

				await this._initDig();
				this.sensor_fault = false;
				this.mutex.release();
				this.log('Sensor ready.');
			} catch(err) {
				setTimeout(() => {
					this.sensor_fault = true;
					this.log("Can't initialize sensor. " + err.message + ". Try again in two seconds...");
					this._initHardware();
				}, 2000);
			}
		}
		async _initDig() {
			const data1 = await this.readSensor(0x88,26,true);
			this._dig_T1 = data1.readUInt16LE(0);
			this._dig_T2 = data1.readInt16LE(2);
			this._dig_T3 = data1.readInt16LE(4);
			this._dig_P1 = data1.readUInt16LE(6);
			this._dig_P2 = data1.readInt16LE(8);
			this._dig_P3 = data1.readInt16LE(10);
			this._dig_P4 = data1.readInt16LE(12);
			this._dig_P5 = data1.readInt16LE(14);
			this._dig_P6 = data1.readInt16LE(16);
			this._dig_P7 = data1.readInt16LE(18);
			this._dig_P8 = data1.readInt16LE(20);
			this._dig_P9 = data1.readInt16LE(22);
				//25-th byte skipped
			this._dig_H1 = data1.readUInt8(25);

			const data2 = await this.readSensor(0xE1,7,true);
			this._dig_H2 = data2.readInt16LE(0);
			this._dig_H3 = data2.readUInt8(2);
			this._dig_H4 = (data2.readInt8(3) << 4) | (data2.readInt8(4) & 0xF);
			this._dig_H5 = (data2.readInt8(5) << 4) | (data2.readInt8(4) >> 4);
			this._dig_H6 = data2.readInt8(6);

// 			this.log('initDig complete.')
		}
		async _checkHWID(){
			return this.readSensor(BME280_HW_ID,1,true)
				.then((data) => {
					if(data.readUInt8() !== 0x60) throw new Error('Hardware ID Error!');
					return true;
				})
		}
		async writeSensor(register, data=Buffer.alloc(0), on_init=false) {
		//register - type of int, data - type of Buffer
			let i2c1;
			const cmdQueue = [
				(cb) => i2c1 = i2c.open(1, cb),
				(cb) => {
					const regbuf = Buffer.from([register]);
					const bytes = regbuf.length + data.length;
					const buffer = Buffer.concat([regbuf, data], bytes)
					i2c1.i2cWrite(BME280_ADDR, bytes, buffer, (err, bytesWritten, buffer) => {
						if (err) return cb(err);
						setTimeout(() => { cb(null, true) }, 50);
					});
				},
				(cb) => i2c1.close(cb)
			];

			if(!on_init) await this.mutex.lock();

			return new Promise((resolve,reject) => {
				async.series(cmdQueue, (err,results) => {
					if(!on_init) this.mutex.release();
					if(err) return reject(err);
					resolve(results[1]);
				})
			})
		}
		async readSensor(register, bytes=1, on_init=false) {
			let i2c1;
			const cmdQueue = [
				(cb) => i2c1 = i2c.open(1, cb),
				(cb) => {
					i2c1.i2cWrite(BME280_ADDR, 1, Buffer.from([register]), (err, bytesWritten, buffer) => {
						if (err) return cb(err);
						setTimeout(() => { cb(null, true) }, 20);
					});
				},
				(cb) => {
					i2c1.i2cRead(BME280_ADDR, bytes, Buffer.alloc(bytes), (err, bytesRead, buffer) => {
						if (err) return cb(err);
						cb(null,buffer);
					});

				},
				(cb) => i2c1.close(cb)
			];

			if(!on_init) {
				if(this.sensor_fault) return Promise.reject(new Error('Sensor is not ready.'))
				await this.mutex.lock();
			}

			return new Promise((resolve,reject) => {
				async.series(cmdQueue, (err,results) => {
					if (err) {
						this.sensor_fault = true;
						if(!on_init) {
							this._initHardware();
						}
						return reject(err);
					};
					if(!on_init) this.mutex.release();
					resolve(results[2]);
				})
			})
		}

		async readSensorData() {
			return this.readSensor(BME280_DATA,8)
				.then(data => {
					const adc_P = data.readUIntBE(0,3) >> 4;
					const adc_T = data.readUIntBE(3,3) >> 4;
					const adc_H = data.readUInt16BE(6);

// 					console.log(this._dig_H1, this._dig_H2, this._dig_H3, this._dig_H4, this._dig_H5, this._dig_H6);
// 					console.log(data);
// 					console.log('-----');
// 					console.log(adc_T);
// 					console.log(adc_P);
// 					console.log(adc_H);
// 					console.log('-----');

					if(adc_T === 0 && adc_P === 524288 && adc_H === 0) return Promise.reject(new Error("BME280: Data not ready!"));

					let tvar1, tvar2, t, t_fine;

					tvar1 = (((adc_T >> 3) - (this._dig_T1 << 1)) * this._dig_T2) >> 11;
					tvar2 = (((((adc_T >> 4) - this._dig_T1) * ((adc_T >> 4) - this._dig_T1)) >> 12) * this._dig_T3) >> 14;
					t_fine = tvar1 + tvar2;
					t = ((t_fine * 5 + 128) >> 8)/100;

					let pvar1, pvar2, p;
					pvar1 = t_fine / 2 - 64000;
					pvar2 = pvar1 * pvar1 * this._dig_P6 / 32768;
					pvar2 = pvar2 + pvar1 * this._dig_P5 * 2;
					pvar2 = pvar2 / 4 + this._dig_P4 * 65536;
					pvar1 = (this._dig_P3 * pvar1 * pvar1 / 524288 + this._dig_P2 * pvar1) / 524288;
					pvar1 = (1 + pvar1 / 32768) * this._dig_P1;

					if(pvar1 !== 0) {
					  p = 1048576 - adc_P;
					  p = ((p - pvar2 / 4096) * 6250) / pvar1;
					  pvar1 = this._dig_P9 * p * p / 2147483648;

					  pvar2 = p * this._dig_P8 / 32768;
					  p = p + (pvar1 + pvar2 + this._dig_P7) / 16;

					  p = p * 0.0075;
					}

					let h = t_fine - 76800.0;
					h = (adc_H - (this._dig_H4 * 64.0 + this._dig_H5 / 16384.0 * h)) * (this._dig_H2 / 65536.0 * (1.0 + this._dig_H6 / 67108864.0 * h *(1.0 + this._dig_H3 / 67108864.0 * h)));
					h = h * (1.0 - this._dig_H1 * h / 524288.0);

					h = (h > 100) ? 100 : (h < 0 ? 0 : h);


					return {temp: t, press: p, humi: h};
				})
		}

		async readTemperature() {
			return this.readSensorData()
				.then(data => data.temp)
		}
		async readPressure() {
			return this.readSensorData()
				.then(data => data.press)
		}
		async readHumidity() {
			return this.readSensorData()
				.then(data => data.humi)
		}

		getAbilities() {
			return ['temperature', 'humidity', 'airpressure'];
		}

//Helper functions

		async resetSensor() {
		//After reset you need init sensor once again
			return this.writeSensor(BME280_RESET, Buffer.from([0xB6]), true)
				.then(() => this.log('Resetting...'));
		}
		async readCtrlMeas() {
			return this.readSensor(BME280_CTRL_MEAS,1)
				.then(data => console.log(data.readUInt8(0).toString(2)));
		}
		async readStatus() {
			return this.readSensor(BME280_STATUS,1)
				.then(console.log);
		}
		async readConfig() {
			return this.readSensor(BME280_CONFIG,1)
// 				.then(console.log)
				.then(data => console.log(data.readUInt8(0).toString(2)));
		}
		async readHWID(){
			return this.readSensor(BME280_HW_ID,1)
				.then((data) => data.readUIntBE(0, 1))
		}
		async readDig(register, bytes) {
			return this.readSensor(register, bytes)
				.then(data => {
					console.log(data);
				})
		}
	}

	return new bme280();
}