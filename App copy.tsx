import React, { useEffect, useRef, useState } from 'react';
import { Buffer } from 'buffer';
global.Buffer = Buffer;

import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Modal,
  TextInput,
  Linking,
  SafeAreaView,
  StatusBar,
  Animated,
  Platform,
  PermissionsAndroid,
  Alert,
  FlatList,
} from 'react-native';
import { BleManager } from 'react-native-ble-plx';
import RNBluetoothClassic from 'react-native-bluetooth-classic';

// Initialize BLE Manager
const bleManager = new BleManager();

// BLE Service and Characteristic UUIDs
const SERVICE_UUID = '0000FFE0-0000-1000-8000-00805F9B34FB';
const CHARACTERISTIC_UUID = '0000FFE1-0000-1000-8000-00805F9B34FB';

// Type definitions
interface Reading {
  ts: Date;
  value: number;
}

interface IconProps {
  name: string;
  size?: number;
  color?: string;
}

// Helper functions
function fmtDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function fmtTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mi}:${ss}`;
}

function filterReadings(readings: Reading[], startDateISO?: string | null, endDateISO?: string | null): Reading[] {
  let start: Date | null = null;
  let end: Date | null = null;
  if (startDateISO && startDateISO.trim()) start = new Date(startDateISO + 'T00:00:00');
  if (endDateISO && endDateISO.trim()) end = new Date(endDateISO + 'T23:59:59');

  if (!start && !end) {
    const now = new Date();
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  }

  return readings.filter((r: Reading) => {
    const afterStart = start ? r.ts >= start : true;
    const beforeEnd = end ? r.ts <= end : true;
    return afterStart && beforeEnd;
  });
}

// Simple Icon Component
const Icon: React.FC<IconProps> = ({ name, size = 24, color = '#fff' }) => {
  const icons: Record<string, string> = {
    menu: '☰',
    bluetooth: '⚡',
    activity: '📊',
    wind: '💨',
    user: '👤',
    info: 'ℹ️',
    shield: '🛡️',
    bell: '🔔',
    logout: '🚪',
    x: '✕',
    edit: '✎',
    radio: '📡',
    alert: '⚠️',
  };

  return (
    <Text style={{ fontSize: size * 0.7, color }}>{icons[name] || '•'}</Text>
  );
};

export default function App() {
  const [activeTab, setActiveTab] = useState<string>('live');
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const [btStatus, setBtStatus] = useState<'connected' | 'connecting' | 'disconnected'>('disconnected');
  const [readings, setReadings] = useState<Reading[]>([]);
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [filtered, setFiltered] = useState<Reading[]>([]);
  const [deviceModalVisible, setDeviceModalVisible] = useState<boolean>(false);
  const [devices, setDevices] = useState<any[]>([]);
  const [scanning, setScanning] = useState<boolean>(false);
  const [connectedDevice, setConnectedDevice] = useState<any>(null);
  const [lastDataTime, setLastDataTime] = useState<Date | null>(null);

  const scrollViewRef = useRef<ScrollView>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const bleSubscription = useRef<any>(null);
  const classicReadInterval = useRef<any>(null);
  const dataCheckInterval = useRef<any>(null);
  const connectedDeviceType = useRef<'BLE' | 'Classic' | null>(null);

  // Request permissions
  useEffect(() => {
    requestPermissions();
    return () => {
      if (bleSubscription.current) {
        bleSubscription.current.remove();
      }
      if (classicReadInterval.current) {
        clearInterval(classicReadInterval.current);
      }
      if (dataCheckInterval.current) {
        clearInterval(dataCheckInterval.current);
      }
      bleManager.destroy();
    };
  }, []);

  const requestPermissions = async () => {
    if (Platform.OS === 'android') {
      try {
        await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
      } catch (err) {
        console.warn(err);
      }
    }
  };

  // Pulse animation
  useEffect(() => {
    if (btStatus === 'connected') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.3, duration: 1000, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
        ])
      ).start();
    }
  }, [btStatus]);

  // Auto-scroll
  useEffect(() => {
    if (scrollViewRef.current && readings.length > 0) {
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [readings]);

  // Filter effect
  useEffect(() => {
    if (!startDate && !endDate) {
      setFiltered(filterReadings(readings, null, null));
    }
  }, [readings, startDate, endDate]);

  // Data check interval
  useEffect(() => {
    if (btStatus === 'connected') {
      dataCheckInterval.current = setInterval(() => {
        if (lastDataTime) {
          const now = new Date();
          const timeSinceLastData = (now.getTime() - lastDataTime.getTime()) / 1000;
          
          if (timeSinceLastData > 15) {
            Alert.alert(
              'No Data Received',
              'No data received from device in the last 15 seconds. Connection may be lost.',
              [{ text: 'OK' }]
            );
          }
        }
      }, 10000);
    } else {
      if (dataCheckInterval.current) {
        clearInterval(dataCheckInterval.current);
        dataCheckInterval.current = null;
      }
    }

    return () => {
      if (dataCheckInterval.current) {
        clearInterval(dataCheckInterval.current);
      }
    };
  }, [btStatus, lastDataTime]);

  const scanForDevices = async () => {
    setScanning(true);
    setDevices([]);
    const foundDevices = new Map();

    // Scan for BLE devices
    bleManager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        console.log('BLE Scan Error:', error);
        return;
      }
      if (device && device.name && !foundDevices.has(device.id)) {
        foundDevices.set(device.id, {
          id: device.id,
          name: device.name,
          type: 'BLE',
          rawDevice: device,
        });
        setDevices(Array.from(foundDevices.values()));
      }
    });

    // Scan for Classic Bluetooth devices
    try {
      const paired = await RNBluetoothClassic.getBondedDevices();
      paired.forEach(device => {
        if (!foundDevices.has(device.address)) {
          foundDevices.set(device.address, {
            id: device.address,
            name: device.name || 'Unknown Device',
            type: 'Classic',
            rawDevice: device,
          });
        }
      });
      setDevices(Array.from(foundDevices.values()));
    } catch (error) {
      console.log('Classic Bluetooth Error:', error);
    }

    setTimeout(() => {
      bleManager.stopDeviceScan();
      setScanning(false);
    }, 10000);
  };

  const connectToDevice = async (deviceInfo: any) => {
    try {
      setBtStatus('connecting');
      bleManager.stopDeviceScan();

      if (deviceInfo.type === 'BLE') {
        // Connect to BLE device
        const device = await bleManager.connectToDevice(deviceInfo.rawDevice.id);
        await device.discoverAllServicesAndCharacteristics();
        
        setConnectedDevice(device);
        connectedDeviceType.current = 'BLE';
        setBtStatus('connected');
        setDeviceModalVisible(false);
        setLastDataTime(new Date());

        bleSubscription.current = device.monitorCharacteristicForService(
          SERVICE_UUID,
          CHARACTERISTIC_UUID,
          (error, characteristic) => {
            if (error) {
              console.log('Monitor Error:', error);
              return;
            }
            if (characteristic?.value) {
              const rawData = Buffer.from(characteristic.value, 'base64').toString('utf-8');
              parseData(rawData);
              setLastDataTime(new Date());
            }
          }
        );

        Alert.alert('Success', `Connected to ${deviceInfo.name} (BLE)`);
      } else {
        // Connect to Classic Bluetooth device
        const device = await RNBluetoothClassic.connectToDevice(deviceInfo.rawDevice.address);
        
        setConnectedDevice(device);
        connectedDeviceType.current = 'Classic';
        setBtStatus('connected');
        setDeviceModalVisible(false);
        setLastDataTime(new Date());

        // Read data periodically from Classic Bluetooth
        classicReadInterval.current = setInterval(async () => {
          try {
            const available = await device.available();
            if (available > 0) {
              const data = await device.read();
              parseData(data);
              setLastDataTime(new Date());
            }
          } catch (error) {
            console.log('Read Error:', error);
          }
        }, 1000);

        Alert.alert('Success', `Connected to ${deviceInfo.name} (Classic)`);
      }
    } catch (error: any) {
      console.error('Connection error:', error);
      setBtStatus('disconnected');
      Alert.alert('Connection Failed', error.message);
    }
  };

  const disconnectDevice = async () => {
    if (connectedDevice) {
      try {
        if (bleSubscription.current) {
          bleSubscription.current.remove();
          bleSubscription.current = null;
        }
        if (classicReadInterval.current) {
          clearInterval(classicReadInterval.current);
          classicReadInterval.current = null;
        }
        if (dataCheckInterval.current) {
          clearInterval(dataCheckInterval.current);
          dataCheckInterval.current = null;
        }

        if (connectedDeviceType.current === 'BLE') {
          await connectedDevice.cancelConnection();
        } else if (connectedDeviceType.current === 'Classic') {
          await connectedDevice.disconnect();
        }

        setConnectedDevice(null);
        connectedDeviceType.current = null;
        setBtStatus('disconnected');
        setLastDataTime(null);
        Alert.alert('Disconnected', 'Device disconnected successfully');
      } catch (error) {
        console.error('Disconnect error:', error);
      }
    }
  };

  const parseData = (rawData: string) => {
    const match = rawData.match(/PM2\.5\(ATM\):\s*([\d.]+)\s*ug\/m3/);
    if (match) {
      const val = parseFloat(match[1]);
      setReadings((prev) => {
        const next = [...prev, { ts: new Date(), value: val }];
        return next.length > 500 ? next.slice(-500) : next;
      });
    }
  };

  const openDeviceModal = () => {
    if (btStatus === 'connected') {
      // If connected, show disconnect option
      Alert.alert(
        'Bluetooth Connected',
        'Do you want to disconnect from the current device?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Disconnect', onPress: disconnectDevice, style: 'destructive' },
        ]
      );
    } else {
      // If not connected, show device list
      setDeviceModalVisible(true);
      scanForDevices();
    }
  };

  const latest = readings.length ? readings[readings.length - 1] : undefined;
  const isConnected = btStatus === 'connected';

  const btBadge = {
    text: btStatus === 'connected' ? 'Connected' : btStatus === 'connecting' ? 'Connecting' : 'Disconnected',
    color: btStatus === 'connected' ? '#22c55e' : btStatus === 'connecting' ? '#eab308' : '#ef4444',
    dotColor: btStatus === 'connected' ? '#4ade80' : btStatus === 'connecting' ? '#facc15' : '#71717a',
    liveText: btStatus === 'connected' ? 'Receiving' : btStatus === 'connecting' ? 'Connecting...' : 'Idle',
  };

  const applyFilter = () => {
    setFiltered(filterReadings(readings, startDate || null, endDate || null));
  };

  const clearFilter = () => {
    setStartDate('');
    setEndDate('');
    setFiltered(filterReadings(readings, null, null));
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#18181b" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setMenuOpen(true)} style={styles.headerButton}>
          <Icon name="menu" size={24} color="#a1a1aa" />
        </TouchableOpacity>

        <TouchableOpacity onPress={() => setActiveTab('live')}>
          <Text style={styles.headerTitle}>Shudhvayu</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={openDeviceModal} style={styles.btButton}>
          <View style={[styles.btCircle, { backgroundColor: isConnected ? '#27272a' : '#3f3f46' }]}>
            <Icon name="bluetooth" size={20} color={btStatus === 'connected' ? '#3b82f6' : '#a1a1aa'} />
          </View>
          <View style={[styles.btBadge, { backgroundColor: btBadge.color }]}>
            <Text style={styles.btBadgeText}>{btBadge.text}</Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* Tab Selector */}
      <View style={styles.tabContainer}>
        <View style={styles.tabInner}>
          <TouchableOpacity
            onPress={() => setActiveTab('live')}
            style={[styles.tab, activeTab === 'live' && styles.tabActive]}
          >
            <Icon name="activity" size={16} color={activeTab === 'live' ? '#18181b' : '#d4d4d8'} />
            <Text style={[styles.tabText, activeTab === 'live' && styles.tabTextActive]}>Live PM2.5</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => setActiveTab('aqi')}
            style={[styles.tab, activeTab === 'aqi' && styles.tabActive]}
          >
            <Icon name="wind" size={16} color={activeTab === 'aqi' ? '#18181b' : '#d4d4d8'} />
            <Text style={[styles.tabText, activeTab === 'aqi' && styles.tabTextActive]}>AQI Report</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Menu Modal */}
      <Modal visible={menuOpen} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={styles.modalBackdrop}
            activeOpacity={1}
            onPress={() => setMenuOpen(false)}
          />
          <View style={styles.menu}>
            <View style={styles.menuHeader}>
              <View>
                <Text style={styles.menuTitle}>Hi, Partner</Text>
                <Text style={styles.menuSubtitle}>Shudhvayu</Text>
              </View>
              <TouchableOpacity onPress={() => setMenuOpen(false)}>
                <Icon name="x" size={24} color="#a1a1aa" />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.menuItems}>
              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => { setActiveTab('profile'); setMenuOpen(false); }}
              >
                <Icon name="user" size={20} color="#d4d4d8" />
                <Text style={styles.menuItemText}>Profile</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => Linking.openURL('https://shudhvayu.com/about')}
              >
                <Icon name="info" size={20} color="#d4d4d8" />
                <Text style={styles.menuItemText}>About Us</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => Linking.openURL('https://shudhvayu.com/privacy')}
              >
                <Icon name="shield" size={20} color="#d4d4d8" />
                <Text style={styles.menuItemText}>Privacy & Security</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => { setActiveTab('support'); setMenuOpen(false); }}
              >
                <Icon name="bell" size={20} color="#d4d4d8" />
                <Text style={styles.menuItemText}>Support</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => Linking.openURL('https://shudhvayu.com/terms')}
              >
                <Icon name="info" size={20} color="#d4d4d8" />
                <Text style={styles.menuItemText}>Terms of Services</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.menuItem, styles.logoutItem]}>
                <Icon name="logout" size={20} color="#f87171" />
                <Text style={styles.logoutText}>Logout</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Device Selection Modal */}
      <Modal visible={deviceModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.deviceModalContent}>
            <Text style={styles.deviceModalTitle}>Select Bluetooth Device</Text>
            
            <View style={styles.deviceListContainer}>
              {scanning ? (
                <Text style={styles.scanningText}>Scanning for devices...</Text>
              ) : devices.length === 0 ? (
                <Text style={styles.noDevicesText}>No devices found. Tap Refresh to scan again.</Text>
              ) : (
                <FlatList
                  data={devices}
                  keyExtractor={(item) => item.id}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={styles.deviceItem}
                      onPress={() => connectToDevice(item)}
                    >
                      <View style={styles.deviceInfo}>
                        <Text style={styles.deviceName}>{item.name}</Text>
                        <Text style={styles.deviceId}>{item.id}</Text>
                      </View>
                      <View style={styles.deviceTypeBadge}>
                        <Text style={styles.deviceTypeText}>{item.type}</Text>
                      </View>
                    </TouchableOpacity>
                  )}
                />
              )}
            </View>

            <TouchableOpacity
              style={styles.refreshBtn}
              onPress={scanForDevices}
              disabled={scanning}
            >
              <Text style={styles.refreshBtnText}>
                {scanning ? 'Scanning...' : '🔄 Refresh'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.closeBtn}
              onPress={() => {
                bleManager.stopDeviceScan();
                setDeviceModalVisible(false);
              }}
            >
              <Text style={styles.closeBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Content */}
      <ScrollView style={styles.content}>
        {/* LIVE TAB */}
        {activeTab === 'live' && (
          <View style={styles.pageContainer}>
            {/* Live Header */}
            <View style={styles.liveHeaderContainer}>
              <View style={styles.liveHeaderTop}>
                <View style={styles.liveTitle}>
                  <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                    <Icon name="radio" size={20} color="#ef4444" />
                  </Animated.View>
                  <Text style={styles.liveTitleText}>Live PM2.5</Text>
                  <View style={styles.liveValue}>
                    <Text style={styles.liveValueText}>
                      {isConnected && latest ? `${latest.value} ug/m³` : '—'}
                    </Text>
                  </View>
                </View>
                <View style={styles.liveStatus}>
                  <View style={[styles.statusDot, { backgroundColor: btBadge.dotColor }]} />
                  <Text style={styles.statusText}>{btBadge.liveText}</Text>
                </View>
              </View>
            </View>

            {/* Live Feed Table */}
            <View style={styles.tableContainer}>
              <View style={styles.tableHeader}>
                <Icon name="activity" size={16} color="#e4e4e7" />
                <Text style={styles.tableHeaderText}>Live Feed - PM2.5</Text>
              </View>

              {btStatus === 'disconnected' ? (
                <View style={styles.disconnectedContainer}>
                  <View style={styles.disconnectedIcons}>
                    <Icon name="alert" size={32} color="#fbbf24" />
                    <Icon name="bluetooth" size={32} color="#fbbf24" />
                  </View>
                  <Text style={styles.disconnectedTitle}>Bluetooth Disconnected</Text>
                  <Text style={styles.disconnectedText}>
                    Tap the <Text style={styles.bold}>Bluetooth icon</Text> to connect your Shudhvayu device.
                  </Text>
                </View>
              ) : readings.length === 0 ? (
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyText}>
                    {btStatus === 'connecting' ? 'Connecting...' : 'Waiting for data...'}
                  </Text>
                </View>
              ) : (
                <ScrollView ref={scrollViewRef} style={styles.tableScroll} nestedScrollEnabled>
                  <View style={styles.tableHeaderRow}>
                    <Text style={[styles.tableHeaderCell, styles.col35]}>Date</Text>
                    <Text style={[styles.tableHeaderCell, styles.col35]}>Time</Text>
                    <Text style={[styles.tableHeaderCell, styles.col30]}>PM2.5(ATM)</Text>
                  </View>
                  {readings.map((r, i) => (
                    <View key={i} style={[styles.tableRow, i % 2 === 1 && styles.tableRowAlt]}>
                      <Text style={[styles.tableCell, styles.col35]}>{fmtDate(r.ts)}</Text>
                      <Text style={[styles.tableCell, styles.col35]}>{fmtTime(r.ts)}</Text>
                      <Text style={[styles.tableCell, styles.col30]}>{r.value} ug/m3</Text>
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>
          </View>
        )}

        {/* AQI REPORT TAB */}
        {activeTab === 'aqi' && (
          <View style={styles.pageContainer}>
            {/* AQI Header with Filters */}
            <View style={styles.aqiHeaderContainer}>
              <View style={styles.aqiTitle}>
                <Icon name="wind" size={20} color="#fff" />
                <Text style={styles.aqiTitleText}>AQI Report</Text>
              </View>

              <View style={styles.filterContainer}>
                <View style={styles.filterRow}>
                  <View style={styles.filterGroup}>
                    <Text style={styles.filterLabel}>START DATE</Text>
                    <TextInput
                      style={styles.dateInput}
                      placeholder="YYYY-MM-DD"
                      placeholderTextColor="#71717a"
                      value={startDate}
                      onChangeText={setStartDate}
                    />
                  </View>

                  <View style={styles.filterGroup}>
                    <Text style={styles.filterLabel}>END DATE</Text>
                    <TextInput
                      style={styles.dateInput}
                      placeholder="YYYY-MM-DD"
                      placeholderTextColor="#71717a"
                      value={endDate}
                      onChangeText={setEndDate}
                    />
                  </View>
                </View>

                <View style={styles.filterButtons}>
                  <TouchableOpacity style={styles.applyButton} onPress={applyFilter}>
                    <Text style={styles.applyButtonText}>Apply</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.clearButton} onPress={clearFilter}>
                    <Text style={styles.clearButtonText}>Clear</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            {/* Results Table */}
            <View style={styles.tableContainer}>
              <View style={styles.tableHeader}>
                <Icon name="activity" size={16} color="#e4e4e7" />
                <Text style={styles.tableHeaderText}>Recorded data</Text>
              </View>

              <ScrollView style={styles.tableScroll} nestedScrollEnabled>
                <View style={styles.tableHeaderRow}>
                  <Text style={[styles.tableHeaderCell, styles.col35]}>Date</Text>
                  <Text style={[styles.tableHeaderCell, styles.col35]}>Time</Text>
                  <Text style={[styles.tableHeaderCell, styles.col30]}>PM2.5(ATM)</Text>
                </View>
                {filtered.length === 0 ? (
                  <View style={styles.emptyContainer}>
                    <Text style={styles.emptyText}>No data for selected range.</Text>
                  </View>
                ) : (
                  filtered.map((r, i) => (
                    <View key={i} style={[styles.tableRow, i % 2 === 1 && styles.tableRowAlt]}>
                      <Text style={[styles.tableCell, styles.col35]}>{fmtDate(r.ts)}</Text>
                      <Text style={[styles.tableCell, styles.col35]}>{fmtTime(r.ts)}</Text>
                      <Text style={[styles.tableCell, styles.col30]}>{r.value} ug/m3</Text>
                    </View>
                  ))
                )}
              </ScrollView>
            </View>
          </View>
        )}

        {/* PROFILE TAB */}
        {activeTab === 'profile' && (
          <View style={styles.profileContainer}>
            <View style={styles.profileHeader}>
              <Text style={styles.profileTitle}>Profile</Text>
              <TouchableOpacity style={styles.editButton}>
                <Icon name="edit" size={20} color="#d4d4d8" />
              </TouchableOpacity>
            </View>

            <View style={styles.profileCard}>
              <View style={styles.profileTop}>
                <View style={styles.avatar}>
                  <Icon name="user" size={40} color="#fff" />
                </View>
                <View>
                  <Text style={styles.profileName}>Partner Account</Text>
                  <Text style={styles.profileSubtitle}>Shudhvayu Partner</Text>
                </View>
              </View>

              <View style={styles.profileDetails}>
                <View style={styles.profileRow}>
                  <Text style={styles.profileLabel}>User Name</Text>
                  <Text style={styles.profileValue}>Partner</Text>
                </View>
                <View style={styles.profileRow}>
                  <Text style={styles.profileLabel}>Organization Name</Text>
                  <Text style={styles.profileValue}>Shudhvayu</Text>
                </View>
                <View style={styles.profileRow}>
                  <Text style={styles.profileLabel}>Email</Text>
                  <Text style={styles.profileValue}>partner@shudhvayu.app</Text>
                </View>
                <View style={[styles.profileRow, styles.profileRowLast]}>
                  <Text style={styles.profileLabel}>Password</Text>
                  <Text style={styles.profileValue}>••••••••</Text>
                </View>
              </View>
            </View>

            <TouchableOpacity style={styles.logoutButton}>
              <Icon name="logout" size={20} color="#f87171" />
              <Text style={styles.logoutButtonText}>Logout</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* SUPPORT TAB */}
        {activeTab === 'support' && (
          <View style={styles.supportContainer}>
            <Text style={styles.supportTitle}>Support</Text>
            <View style={styles.supportCard}>
              <Text style={styles.supportText}>Need help? Contact support@shudhvayu.app</Text>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#18181b',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
  },
  headerButton: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#fff',
  },
  btButton: {
    position: 'relative',
  },
  btCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btBadge: {
    position: 'absolute',
    bottom: -4,
    right: -4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  btBadgeText: {
    fontSize: 10,
    color: '#fff',
    fontWeight: '600',
  },
  tabContainer: {
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
  },
  tabInner: {
    flexDirection: 'row',
    backgroundColor: '#27272a',
    padding: 4,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#3f3f46',
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginHorizontal: 2,
  },
  tabActive: {
    backgroundColor: '#fff',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#d4d4d8',
    marginLeft: 8,
  },
  tabTextActive: {
    color: '#18181b',
  },
  modalOverlay: {
    flex: 1,
  },
  modalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  menu: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: 280,
    backgroundColor: '#27272a',
  },
  menuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#3f3f46',
  },
  menuTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#fff',
  },
  menuSubtitle: {
    fontSize: 14,
    color: '#a1a1aa',
    marginTop: 4,
  },
  menuItems: {
    flex: 1,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#3f3f46',
  },
  menuItemText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#d4d4d8',
    marginLeft: 12,
  },
  logoutItem: {
    borderTopWidth: 1,
    borderTopColor: '#3f3f46',
  },
  logoutText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#f87171',
    marginLeft: 12,
  },
  content: {
    flex: 1,
  },
  pageContainer: {
    padding: 16,
  },
  liveHeaderContainer: {
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
  },
  liveHeaderTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  liveTitle: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  liveTitleText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#fff',
    marginLeft: 8,
  },
  liveValue: {
    backgroundColor: '#fff',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    marginLeft: 8,
  },
  liveValueText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#18181b',
  },
  liveStatus: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  statusText: {
    fontSize: 11,
    color: '#d4d4d8',
  },
  tableContainer: {
    backgroundColor: '#18181b',
    borderWidth: 1,
    borderColor: '#27272a',
    borderRadius: 8,
    overflow: 'hidden',
  },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#27272a',
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
  },
  tableHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#e4e4e7',
    marginLeft: 8,
  },
  tableScroll: {
    maxHeight: 400,
  },
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: '#3f3f46',
    padding: 12,
  },
  tableHeaderCell: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
  col35: {
    width: '35%',
  },
  col30: {
    width: '30%',
  },
  tableRow: {
    flexDirection: 'row',
    padding: 12,
  },
  tableRowAlt: {
    backgroundColor: '#0a0a0b',
  },
  tableCell: {
    fontSize: 13,
    color: '#d4d4d8',
  },
  disconnectedContainer: {
    padding: 32,
    alignItems: 'center',
  },
  disconnectedIcons: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  disconnectedTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#fcd34d',
    marginBottom: 8,
  },
  disconnectedText: {
    fontSize: 14,
    color: '#fde68a',
    textAlign: 'center',
  },
  bold: {
    fontWeight: 'bold',
  },
  emptyContainer: {
    padding: 16,
  },
  emptyText: {
    fontSize: 12,
    color: '#71717a',
  },
  aqiHeaderContainer: {
    marginBottom: 12,
  },
  aqiTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  aqiTitleText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#fff',
    marginLeft: 8,
  },
  filterContainer: {
    backgroundColor: '#27272a',
    borderWidth: 1,
    borderColor: '#3f3f46',
    borderRadius: 8,
    padding: 12,
  },
  filterRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  filterGroup: {
    flex: 1,
    marginHorizontal: 4,
  },
  filterLabel: {
    fontSize: 10,
    color: '#a1a1aa',
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  dateInput: {
    backgroundColor: '#18181b',
    borderWidth: 1,
    borderColor: '#3f3f46',
    borderRadius: 6,
    padding: 8,
    color: '#fff',
    fontSize: 14,
  },
  filterButtons: {
    flexDirection: 'row',
  },
  applyButton: {
    flex: 1,
    backgroundColor: '#fff',
    padding: 10,
    borderRadius: 6,
    alignItems: 'center',
    marginHorizontal: 4,
  },
  applyButtonText: {
    color: '#18181b',
    fontSize: 14,
    fontWeight: '500',
  },
  clearButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#52525b',
    padding: 10,
    borderRadius: 6,
    alignItems: 'center',
    marginHorizontal: 4,
  },
  clearButtonText: {
    color: '#e4e4e7',
    fontSize: 14,
  },
  profileContainer: {
    padding: 16,
  },
  profileHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  profileTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  editButton: {
    padding: 8,
    backgroundColor: '#27272a',
    borderWidth: 1,
    borderColor: '#3f3f46',
    borderRadius: 8,
  },
  profileCard: {
    backgroundColor: '#27272a',
    borderWidth: 1,
    borderColor: '#3f3f46',
    borderRadius: 8,
    padding: 24,
    marginBottom: 24,
  },
  profileTop: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#f97316',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  profileName: {
    fontSize: 20,
    fontWeight: '600',
    color: '#fff',
  },
  profileSubtitle: {
    fontSize: 14,
    color: '#a1a1aa',
    marginTop: 4,
  },
  profileDetails: {
    gap: 0,
  },
  profileRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#3f3f46',
  },
  profileRowLast: {
    borderBottomWidth: 0,
  },
  profileLabel: {
    fontSize: 14,
    color: '#a1a1aa',
  },
  profileValue: {
    fontSize: 14,
    fontWeight: '500',
    color: '#fff',
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
    borderRadius: 8,
  },
  logoutButtonText: {
    fontSize: 16,
    fontWeight: '500',
    color: '#f87171',
    marginLeft: 12,
  },
  supportContainer: {
    padding: 24,
  },
  supportTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 8,
  },
  supportCard: {
    backgroundColor: '#27272a',
    borderWidth: 1,
    borderColor: '#3f3f46',
    borderRadius: 8,
    padding: 16,
  },
  supportText: {
    fontSize: 14,
    color: '#e4e4e7',
  },
  // Device Modal Styles
  deviceModalContent: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#27272a',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '80%',
  },
  deviceModalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 16,
    textAlign: 'center',
  },
  deviceListContainer: {
    maxHeight: 300,
    marginBottom: 16,
  },
  scanningText: {
    textAlign: 'center',
    fontSize: 14,
    color: '#a1a1aa',
    padding: 20,
  },
  noDevicesText: {
    textAlign: 'center',
    fontSize: 14,
    color: '#71717a',
    padding: 20,
  },
  deviceItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#3f3f46',
    backgroundColor: '#18181b',
    marginBottom: 8,
    borderRadius: 8,
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 4,
  },
  deviceId: {
    fontSize: 12,
    color: '#a1a1aa',
  },
  deviceTypeBadge: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  deviceTypeText: {
    fontSize: 11,
    color: '#fff',
    fontWeight: '600',
  },
  refreshBtn: {
    backgroundColor: '#22c55e',
    padding: 14,
    borderRadius: 8,
    marginBottom: 10,
  },
  refreshBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  closeBtn: {
    backgroundColor: '#3f3f46',
    padding: 14,
    borderRadius: 8,
  },
  closeBtnText: {
    color: '#e4e4e7',
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
  },
});

