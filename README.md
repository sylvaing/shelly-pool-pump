# shelly-pool-pump
Automatic schedule of your pool pump with temperature and freeze mode

This script is intended to  manage your pool pump from a Shelly Plus device.
He is compatible from firmware 0.11

The goal of this script is to make independant filtration system with just monitor and action with your home automation system.
If there is an issue ( your HA, network, .. ) Shelly device can continu to manage your filtration to have clear water :-)
 
Based on shelly script of ggilles with lot of new feature and improvment.
https://www.shelly-support.eu/forum/index.php?thread/14810-script-randomly-killed-on-shelly-plus-1pm/

Calculate duration filter from current temperature of water, and use max temp of the day and yesterday. The script use sun noon
to calculate the start of script and the end. the morning and the afternoon are separate by sun noon, and duration are equal.
manage freeze mode : under 2°C pump will be activate to prevent freeze of water.

Publish informations on MQTT for Home Assistant autodiscover, all sensors and switch are autocreate in your home assitant.
Before use the script you must configure correcly your Shelly device to connect a your MQTT broker trought web interface or shelly app.

Today, there are no native external sensor, so you must publish temp of water and external temperature on one MQTT topic "ha/pool/...". you have
configuration package 'pool_pum.yaml' to do this, replace and addapt tou your sensor and configuration.

You must also publish th next_noon on the same topic, to calulate the middle of duration filtration

You have au slider to configure the factor of duration filtration, if you want adapt this, by default its 1, put you can choose what you want.

## Features:
* use sun noon to balance duration filtration
* Home Assistant MQTT Autodiscover sensors and switchs
    * start
    * stop
    * duration
    * display mode : freeze or summer
    * set coefficient of duration
    * status of pump
    * select mode : Auto, Force off,  Force on
* auto apply Freeze mode if water is under 2°C.
* customize duration with coefficient of duration
* choose manually to select Force On or off filtration or choose to use the "IA" :-) of script to manage your pump with Auto mode.


## Configuration of HA:

* you must have
    * sun integration in your ha to provide sun.next_noon
    * temperature sensor of your water. I use DS18b20 with an shelly on for me, but you can use what you want
    * external temperature sensor in order to detect risk of water freeze

* add an automation:
I publish my file pool_pump.yaml for use with package or rewrite automation as you want.
You mus have an automation which published all necessary temp sensors and sun.next_noon

## Connect shelly to your filtration pump system

The shelly hardware (for me shelly 1 plus) mus replace your hardware clock in your electic panel.
But, be careful, you don't just use your shelly schema like for a light. There pic of current at start of pump so your shelly can have some problem and fire if you do that.
In theory Your old hardware clock is connected to a relay. your shelly must make order to the relay to turn on/off the pump, not your shelly !!
So ! if you unerstand you cant's use shelly plus 1PM to monitor energy, because it must be conneected in direct. I suggest you to use Shelly EM with clamps to monitor energy.



## TODO
* When Shelly addon temperature will be avaible use this to not user sensor of external hardware and make shelly really autonomous if issue on HA or network
* I wouldlike use Home assitant PI to request directly HA by API, in order to not configure AUtomation to publish some infortaions,
but the lenght of the token is too loong for shelly script. Perhaps in the futur..
* improve the doc to connect shelly with your hardware.





## Command view on Home Assitant:

![HA-ShellyPump](docs/ha-shellypump.png)

