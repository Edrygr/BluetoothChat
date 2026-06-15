package com.bluetoothchat

import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.os.ParcelUuid
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.UUID

class BlePeripheralModule(private val reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "BlePeripheral"
        val SERVICE_UUID: UUID = UUID.fromString("A1234567-89AB-CDEF-0123-456789ABCDEF")
        val TX_UUID: UUID      = UUID.fromString("A1234568-89AB-CDEF-0123-456789ABCDEF")
        val RX_UUID: UUID      = UUID.fromString("A1234569-89AB-CDEF-0123-456789ABCDEF")
        val CCCD_UUID: UUID    = UUID.fromString("00002902-0000-1000-8000-00805F9B34FB")
    }

    private var gattServer: BluetoothGattServer? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private val connectedCentrals = mutableMapOf<String, BluetoothDevice>()

    private val notifyChar = BluetoothGattCharacteristic(
        RX_UUID,
        BluetoothGattCharacteristic.PROPERTY_NOTIFY,
        BluetoothGattCharacteristic.PERMISSION_READ
    ).also {
        it.addDescriptor(
            BluetoothGattDescriptor(
                CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
            )
        )
    }

    private val gattCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    connectedCentrals[device.address] = device
                    emit("BlePeripheralCentralConnected", device.address)
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    connectedCentrals.remove(device.address)
                    emit("BlePeripheralCentralDisconnected", device.address)
                }
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice, requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean, responseNeeded: Boolean,
            offset: Int, value: ByteArray
        ) {
            if (characteristic.uuid == TX_UUID) {
                if (responseNeeded) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
                }
                val params = Arguments.createMap().apply {
                    putString("address", device.address)
                    putString("data", String(value, Charsets.UTF_8))
                }
                emit("BlePeripheralDataReceived", params)
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice, requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean, responseNeeded: Boolean,
            offset: Int, value: ByteArray
        ) {
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }
        }
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartFailure(errorCode: Int) {
            emit("BlePeripheralError", "Advertising failed: $errorCode")
        }
    }

    override fun getName() = NAME

    @ReactMethod
    fun start(promise: Promise) {
        try {
            val btManager = reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager

            val txChar = BluetoothGattCharacteristic(
                TX_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE or
                BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                BluetoothGattCharacteristic.PERMISSION_WRITE
            )

            val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY).apply {
                addCharacteristic(txChar)
                addCharacteristic(notifyChar)
            }

            gattServer = btManager.openGattServer(reactContext, gattCallback)
            gattServer?.addService(service)

            val settings = AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setConnectable(true)
                .setTimeout(0)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                .build()

            val data = AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceUuid(ParcelUuid(SERVICE_UUID))
                .build()

            advertiser = btManager.adapter.bluetoothLeAdvertiser
            advertiser?.startAdvertising(settings, data, advertiseCallback)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("START_FAILED", e.message)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        try {
            advertiser?.stopAdvertising(advertiseCallback)
            gattServer?.close()
        } catch (_: Exception) {}
        gattServer = null
        connectedCentrals.clear()
        promise.resolve(null)
    }

    @ReactMethod
    fun send(address: String, data: String, promise: Promise) {
        val device = connectedCentrals[address]
        if (device == null) {
            promise.reject("NOT_CONNECTED", "No central: $address")
            return
        }
        notifyChar.value = data.toByteArray(Charsets.UTF_8)
        val ok = gattServer?.notifyCharacteristicChanged(device, notifyChar, false) ?: false
        if (ok) promise.resolve(null)
        else promise.reject("NOTIFY_FAILED", "Notification failed")
    }

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    private fun emit(event: String, data: Any?) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(event, data)
    }
}
