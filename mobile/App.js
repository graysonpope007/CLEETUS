import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import * as Font from 'expo-font';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
} from '@expo-google-fonts/inter';
import {
  PlayfairDisplay_400Regular,
  PlayfairDisplay_700Bold,
  PlayfairDisplay_400Regular_Italic,
} from '@expo-google-fonts/playfair-display';
import {
  CourierPrime_400Regular,
  CourierPrime_700Bold,
} from '@expo-google-fonts/courier-prime';

import { colors } from './src/theme';
import DashboardScreen from './src/screens/DashboardScreen';
import ChatScreen from './src/screens/ChatScreen';
import ChatsScreen from './src/screens/ChatsScreen';
import MemoryScreen from './src/screens/MemoryScreen';
import SMSScreen from './src/screens/SMSScreen';

SplashScreen.preventAutoHideAsync();

const Tab = createBottomTabNavigator();
const ChatStack = createNativeStackNavigator();

function TabIcon({ name, color, focused }) {
  const icons = {
    Home: focused
      ? '◉'  : '○',
    Chat: focused ? '◆' : '◇',
    Chats: focused ? '▪' : '▫',
    Memory: focused ? '●' : '○',
    SMS: focused ? '▸' : '▹',
  };
  return (
    <View style={{ alignItems: 'center', gap: 2 }}>
      <Text style={{ fontSize: 16, color }}>{icons[name] || '○'}</Text>
    </View>
  );
}

function ChatStackNavigator() {
  return (
    <ChatStack.Navigator
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}
    >
      <ChatStack.Screen name="Chat" component={ChatScreen} />
    </ChatStack.Navigator>
  );
}

const navTheme = {
  dark: true,
  colors: {
    primary: colors.gold,
    background: colors.bg,
    card: colors.surface,
    text: colors.text,
    border: colors.goldRule,
    notification: colors.gold,
  },
};

export default function App() {
  const [fontsLoaded, setFontsLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        await Font.loadAsync({
          Inter_400Regular,
          Inter_500Medium,
          Inter_600SemiBold,
          PlayfairDisplay_400Regular,
          PlayfairDisplay_700Bold,
          PlayfairDisplay_400Regular_Italic,
          CourierPrime_400Regular,
          CourierPrime_700Bold,
        });
      } catch (e) {
        console.warn('Font load error:', e);
      } finally {
        setFontsLoaded(true);
      }
    })();
  }, []);

  const onLayoutRoot = useCallback(async () => {
    if (fontsLoaded) {
      await SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <SafeAreaProvider>
      <View style={styles.root} onLayout={onLayoutRoot}>
        <NavigationContainer theme={navTheme}>
          <Tab.Navigator
            screenOptions={({ route }) => ({
              headerShown: false,
              tabBarStyle: styles.tabBar,
              tabBarActiveTintColor: colors.gold,
              tabBarInactiveTintColor: colors.textMuted,
              tabBarLabelStyle: styles.tabLabel,
              tabBarIcon: ({ color, focused }) => (
                <TabIcon name={route.name} color={color} focused={focused} />
              ),
            })}
          >
            <Tab.Screen
              name="Home"
              component={DashboardScreen}
              options={{ tabBarLabel: 'Home' }}
            />
            <Tab.Screen
              name="Chat"
              component={ChatStackNavigator}
              options={{ tabBarLabel: 'Chat' }}
            />
            <Tab.Screen
              name="Chats"
              component={ChatsScreen}
              options={{ tabBarLabel: 'Chats' }}
            />
            <Tab.Screen
              name="Memory"
              component={MemoryScreen}
              options={{ tabBarLabel: 'Memory' }}
            />
            <Tab.Screen
              name="SMS"
              component={SMSScreen}
              options={{ tabBarLabel: 'SMS' }}
            />
          </Tab.Navigator>
        </NavigationContainer>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  tabBar: {
    backgroundColor: 'rgba(11,25,20,0.95)',
    borderTopColor: colors.goldRule,
    borderTopWidth: 1,
    paddingTop: 4,
    height: 72,
    paddingBottom: 8,
  },
  tabLabel: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 9,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 2,
  },
});
