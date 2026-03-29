## Logical Device

### Kasa Plug
```
    driver: 'kasa',
    category: 'power',
    type: 'relay'
    state: {
        on_off: 0,
    },
    controllable: ['on_off'],
```

### Kasa Bulb or RGB Strip
```
    driver: 'kasa',
    category: 'power',
    type: 'light'
    state: {
        on_off: 0,
        brightness: 123,
        red: 0,
        green: 0,
        blue: 0,
        hue: 0,
        saturation: 0,
        color_temp: 0
    },
    controllable: ['on_off', 'brightness', 'red', 'green', 'blue', 'hue', 'saturation', 'color_temp],
```

### IOT Relay (with PWM light)
```
    driver: 'iot',
    category: 'power',
    type: 'light'
    state: {
        on_off: 0,
        brightness: 123
    }
    controllable: ['on_off', 'brightness']    
```
Map to state: ['isOn', 'percentage']

### IOT RGB Strip
```
    driver: 'iot',
    category: 'power',
    type: 'light'
    state: {
        on_off: 0,
        brightness: 123,
        red: 0,
        green: 0,
        blue: 0,
    },
    controllable: ['on_off', 'brightness', 'red', 'green', 'blue'],
```
Map to state: ['isOn', 'r', 'g', 'b', 'percentage']



### IOT Sensor
```
    driver: 'iot',
    category: 'sensor',
    type: 'BME280',
    state: {
        temperature: 0,
        humidity: 0,
        pressure: 0    
    }
```
Map to state: ['temperature', 'humidity', 'pressure']
